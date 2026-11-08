import { randomUUID } from "node:crypto";
import { jsonResponse } from "../shared/http";
import { getCallerUserId } from "../shared/authorization";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamodb, isConditionalCheckFailed } from "../shared/dynamodb";
import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  normalizeEmail,
  parseJsonBody,
  requiredText,
} from "../shared/validation";
import {
  isAccessError,
  loadOrganizationAccess,
  type OrganizationAccessOptions,
} from "../shared/organizations";
import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  logoKeyPrefix,
  s3,
  signedAvatarUrl,
} from "../shared/avatars";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * Maximum lengths for the editable text fields.
 */
const NAME_MAX_LENGTH = 120;
const PHONE_MAX_LENGTH = 30;

/**
 * Config
 *
 * Environment values the resolver needs.
 */
interface Config {
  bucket: string;
  membershipsTable: string;
  organizationsTable: string;
}

/**
 * SettingsChanges
 *
 * Validated changes: values to set, attributes to remove, and the logo key
 * when the logo is being replaced or removed.
 */
interface SettingsChanges {
  remove: string[];
  logoKey?: string | null;
  set: Record<string, string>;
}

/**
 * Reads the required configuration from the environment, throwing when any
 * value is missing so the deployment error surfaces immediately.
 *
 * @returns The resolved configuration
 */
function loadConfig(): Config {
  const config = {
    bucket: process.env.PROFILE_PICTURES_BUCKET_NAME,
    membershipsTable: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
    organizationsTable: process.env.ORGANIZATIONS_TABLE_NAME,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error("Organization settings Lambda is missing configuration");
  }
  return config as Config;
}

/**
 * ManageOrganizationSettingsResolver Handler
 *
 * Organization profile settings: name, contact details, time zone, and logo.
 *
 *  - GET   /organizations/{organizationId}/settings  Any active member
 *  - PATCH /organizations/{organizationId}/settings  Organization admins only
 *  - POST  /organizations/{organizationId}/logo      Organization admins only
 *
 * @param event The API Gateway event
 * @returns The response for the matched route
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getCallerUserId(event);
  const organizationId = event.pathParameters?.organizationId;

  if (!userId) {
    return jsonResponse(event, 401, { message: "Unauthorized" });
  }
  if (!organizationId) {
    return jsonResponse(event, 400, { message: "organizationId is required" });
  }

  const route = `${event.httpMethod} ${event.resource}`;
  const reads = route === "GET /organizations/{organizationId}/settings";
  const writes =
    route === "PATCH /organizations/{organizationId}/settings" ||
    route === "POST /organizations/{organizationId}/logo";
  if (!reads && !writes) {
    return jsonResponse(event, 405, { message: "Method not allowed" });
  }

  const config = loadConfig();

  // Reads are open to members; every write requires an organization admin.
  const options: OrganizationAccessOptions = {
    organizationsTable: config.organizationsTable,
    membershipsTable: config.membershipsTable,
    allowedRoles: reads ? ["ADMIN", "STAFF"] : ["ADMIN"],
  };
  const access = await loadOrganizationAccess(
    event,
    userId,
    organizationId,
    options,
  );
  if (isAccessError(access)) return access;

  switch (route) {
    case "GET /organizations/{organizationId}/settings":
      return jsonResponse(
        event,
        200,
        await toSettings(
          access.organization as unknown as Record<string, unknown>,
        ),
      );
    case "PATCH /organizations/{organizationId}/settings":
      return updateSettings(event, config, organizationId);
    default:
      return createLogoUpload(event, config, organizationId);
  }
};

/**
 * Projects a stored organization to the settings clients see: the logo key
 * becomes a signed URL, and the data region is where this API runs.
 *
 * @param organization The stored organization item
 * @returns The settings payload
 */
async function toSettings(organization: Record<string, unknown>) {
  const { organizationId, name, contactEmail, phone, timeZone, logoKey } =
    organization;
  return {
    organizationId,
    name,
    contactEmail,
    phone,
    timeZone,
    logoUrl:
      typeof logoKey === "string" ? await signedAvatarUrl(logoKey) : undefined,
    dataRegion: process.env.AWS_REGION,
  };
}

/**
 * Validates the editable fields in a request body.
 *
 * @param body The parsed request body
 * @param organizationId The organization whose logo prefix keys must use
 * @returns The validated changes, or an error message
 */
function validateChanges(
  body: Record<string, unknown>,
  organizationId: string,
): SettingsChanges | string {
  const changes: SettingsChanges = { set: {}, remove: [] };
  const isClear = (value: unknown) => value === null || value === "";

  if (body.name !== undefined) {
    const name = requiredText(body.name, NAME_MAX_LENGTH);
    if (!name) return `name must be 1 to ${NAME_MAX_LENGTH} characters`;
    changes.set.name = name;
  }

  if (body.contactEmail !== undefined) {
    if (isClear(body.contactEmail)) {
      changes.remove.push("contactEmail");
    } else {
      const email = normalizeEmail(body.contactEmail);
      if (!email) return "contactEmail must be a valid email address";
      changes.set.contactEmail = email;
    }
  }

  if (body.phone !== undefined) {
    if (isClear(body.phone)) {
      changes.remove.push("phone");
    } else {
      const phone = requiredText(body.phone, PHONE_MAX_LENGTH);
      if (!phone || !/^[\d\s()+\-.x]{7,}$/i.test(phone)) {
        return "phone must be a valid phone number";
      }
      changes.set.phone = phone;
    }
  }

  if (body.timeZone !== undefined) {
    if (
      typeof body.timeZone !== "string" ||
      !Intl.supportedValuesOf("timeZone").includes(body.timeZone)
    ) {
      return "timeZone must be a valid IANA time zone, e.g. America/Toronto";
    }
    changes.set.timeZone = body.timeZone;
  }

  if (body.logoKey !== undefined) {
    const prefix = logoKeyPrefix(organizationId);
    if (body.logoKey === null) {
      changes.remove.push("logoKey");
      changes.logoKey = null;
    } else if (
      typeof body.logoKey === "string" &&
      body.logoKey.startsWith(prefix) &&
      body.logoKey.length > prefix.length
    ) {
      changes.set.logoKey = body.logoKey;
      changes.logoKey = body.logoKey;
    } else {
      return "logoKey must be a key returned by the logo upload endpoint, or null";
    }
  }

  if (Object.keys(changes.set).length + changes.remove.length === 0) {
    return "At least one setting is required";
  }
  return changes;
}

/**
 * Update Settings
 *
 * Applies the validated changes to the organization and returns the new
 * settings. A replaced or removed logo is deleted from the bucket.
 *
 * @param event The API Gateway event
 * @param config The resolved configuration
 * @param organizationId The organization to update
 * @returns A 200 response with the updated settings, or a 4xx error
 */
async function updateSettings(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<Record<string, unknown>>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const changes = validateChanges(body, organizationId);
  if (typeof changes === "string") {
    return jsonResponse(event, 400, { message: changes });
  }

  const current = await dynamodb.send(
    new GetCommand({
      TableName: config.organizationsTable,
      Key: { organizationId },
      ConsistentRead: true,
    }),
  );
  const previousKey = current.Item?.logoKey as string | undefined;

  // A logo is only accepted once it has really been uploaded, and it must
  // still meet the type and size limits the upload policy enforced.
  if (typeof changes.logoKey === "string") {
    try {
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: changes.logoKey }),
      );
      const type = head.ContentType as (typeof AVATAR_CONTENT_TYPES)[number];
      if (
        !AVATAR_CONTENT_TYPES.includes(type) ||
        (head.ContentLength ?? 0) > AVATAR_MAX_BYTES
      ) {
        return jsonResponse(event, 400, {
          message: "Uploaded file is not an accepted image",
        });
      }
    } catch (error) {
      if ((error as { name?: string }).name === "NotFound") {
        return jsonResponse(event, 400, { message: "Upload not found" });
      }
      throw error;
    }
  }

  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, string> = {
    ":updatedAt": new Date().toISOString(),
  };
  const assignments = ["#updatedAt = :updatedAt"];
  for (const [field, value] of Object.entries(changes.set)) {
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    assignments.push(`#${field} = :${field}`);
  }
  for (const field of changes.remove) names[`#${field}`] = field;

  let updated;
  try {
    updated = await dynamodb.send(
      new UpdateCommand({
        TableName: config.organizationsTable,
        Key: { organizationId },
        UpdateExpression:
          `SET ${assignments.join(", ")}` +
          (changes.remove.length > 0
            ? ` REMOVE ${changes.remove.map((field) => `#${field}`).join(", ")}`
            : ""),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(organizationId)",
        ReturnValues: "ALL_NEW",
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return jsonResponse(event, 404, { message: "Organization not found" });
    }
    throw error;
  }

  // Clean up the replaced logo. Failing to delete only leaves an orphan.
  if (
    previousKey &&
    changes.logoKey !== undefined &&
    previousKey !== changes.logoKey
  ) {
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: previousKey }),
      );
    } catch (error) {
      console.error("Failed to delete previous logo", { error });
    }
  }

  return jsonResponse(
    event,
    200,
    await toSettings(updated.Attributes as Record<string, unknown>),
  );
}

/**
 * Create Logo Upload
 *
 * Returns a presigned POST for one logo. The signed policy limits the file to
 * 5 MB and the declared image type, and pins the key under the organization's
 * own prefix. The client then PATCHes the settings with the returned key.
 *
 * @param event The API Gateway event
 * @param config The resolved configuration
 * @param organizationId The organization the logo belongs to
 * @returns A 200 response with the upload URL, form fields, and key
 */
async function createLogoUpload(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<{ contentType?: unknown }>(event);
  const contentType = body?.contentType;
  if (
    typeof contentType !== "string" ||
    !AVATAR_CONTENT_TYPES.includes(
      contentType as (typeof AVATAR_CONTENT_TYPES)[number],
    )
  ) {
    return jsonResponse(event, 400, {
      message: `contentType must be one of: ${AVATAR_CONTENT_TYPES.join(", ")}`,
    });
  }

  const key = `${logoKeyPrefix(organizationId)}${randomUUID()}`;
  const post = await createPresignedPost(s3, {
    Bucket: config.bucket,
    Key: key,
    Conditions: [
      ["content-length-range", 1, AVATAR_MAX_BYTES],
      ["eq", "$Content-Type", contentType],
    ],
    Fields: { "Content-Type": contentType },
    Expires: 300,
  });

  return jsonResponse(event, 200, {
    url: post.url,
    fields: post.fields,
    key,
    maxBytes: AVATAR_MAX_BYTES,
  });
}
