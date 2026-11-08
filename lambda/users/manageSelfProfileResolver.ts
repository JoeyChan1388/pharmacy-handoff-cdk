import { randomUUID } from "node:crypto";
import { jsonResponse } from "../shared/http";
import { getCallerUserId } from "../shared/authorization";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { parseJsonBody, requiredText } from "../shared/validation";
import { dynamodb, isConditionalCheckFailed } from "../shared/dynamodb";
import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  avatarKeyPrefix,
  s3,
  withAvatarUrl,
} from "../shared/avatars";
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * Cognito Client
 *
 * Used to keep the Cognito name attributes in step with the profile.
 */
const cognito = new CognitoIdentityProviderClient({});

/**
 * Maximum length of a given or family name, or a default location ID.
 */
const FIELD_MAX_LENGTH = 100;

/**
 * Boolean notification preferences a user can set on themselves.
 */
const BOOLEAN_PREFERENCES = [
  "emailUrgentAlerts",
  "emailNewMessages",
  "dailyHandoffDigest",
] as const;

/**
 * Config
 *
 * Environment values the resolver needs.
 */
interface Config {
  bucket: string;
  usersTable: string;
  staffUserPoolId: string;
}

/**
 * ProfileChanges
 *
 * Validated changes: values to set, attributes to remove, and the Cognito
 * attributes to mirror.
 */
interface ProfileChanges {
  remove: string[];
  /** Set when the avatar is being replaced or removed. */
  avatarKey?: string | null;
  set: Record<string, string | boolean>;
  cognitoAttributes: { Name: string; Value: string }[];
}

/**
 * Reads the required configuration from the environment, throwing when any
 * value is missing so the deployment error surfaces immediately.
 *
 * @returns The resolved configuration
 */
function loadConfig(): Config {
  const config = {
    usersTable: process.env.USERS_TABLE_NAME,
    bucket: process.env.PROFILE_PICTURES_BUCKET_NAME,
    staffUserPoolId: process.env.STAFF_USER_POOL_ID,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error("Self profile Lambda is missing configuration");
  }
  return config as Config;
}

/**
 * ManageSelfProfileResolver Handler
 *
 * Lets a signed-in staff user edit their own profile.
 *
 *  - PATCH /staff/me         Updates name, preferences, or profile picture
 *  - POST  /staff/me/avatar  Returns a presigned POST for uploading a picture
 *
 * The caller is always the authenticated user; there is no way to name
 * another user. Email is the sign-in identity and cannot be changed here.
 *
 * @param event The API Gateway event
 * @returns The response for the matched route
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getCallerUserId(event);
  if (!userId) {
    return jsonResponse(event, 401, { message: "Unauthorized" });
  }

  const config = loadConfig();

  switch (`${event.httpMethod} ${event.resource}`) {
    case "PATCH /staff/me":
      return updateProfile(event, config, userId);
    case "POST /staff/me/avatar":
      return createAvatarUpload(event, config, userId);
    default:
      return jsonResponse(event, 405, { message: "Method not allowed" });
  }
};

/**
 * Validates the editable fields in a request body.
 *
 * @param body The parsed request body
 * @param userId The caller, whose picture prefix avatar keys must use
 * @returns The validated changes, or an error message
 */
function validateChanges(
  body: Record<string, unknown>,
  userId: string,
): ProfileChanges | string {
  const changes: ProfileChanges = {
    set: {},
    remove: [],
    cognitoAttributes: [],
  };

  for (const [field, attribute] of [
    ["givenName", "given_name"],
    ["familyName", "family_name"],
  ] as const) {
    if (body[field] === undefined) continue;
    const value = requiredText(body[field], FIELD_MAX_LENGTH);
    if (!value) {
      return `${field} must be 1 to ${FIELD_MAX_LENGTH} characters`;
    }
    changes.set[field] = value;
    changes.cognitoAttributes.push({ Name: attribute, Value: value });
  }

  if (body.defaultLocationId !== undefined) {
    if (body.defaultLocationId === null || body.defaultLocationId === "") {
      changes.remove.push("defaultLocationId");
    } else {
      const value = requiredText(body.defaultLocationId, FIELD_MAX_LENGTH);
      if (!value) return "defaultLocationId must be a location ID or null";
      changes.set.defaultLocationId = value;
    }
  }

  if (body.timeFormat !== undefined) {
    if (body.timeFormat !== "12h" && body.timeFormat !== "24h") {
      return 'timeFormat must be "12h" or "24h"';
    }
    changes.set.timeFormat = body.timeFormat;
  }

  for (const field of BOOLEAN_PREFERENCES) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "boolean") return `${field} must be a boolean`;
    changes.set[field] = body[field];
  }

  if (body.avatarKey !== undefined) {
    if (body.avatarKey === null) {
      changes.remove.push("avatarKey");
      changes.avatarKey = null;
    } else if (
      typeof body.avatarKey === "string" &&
      body.avatarKey.startsWith(avatarKeyPrefix(userId)) &&
      body.avatarKey.length > avatarKeyPrefix(userId).length
    ) {
      changes.set.avatarKey = body.avatarKey;
      changes.avatarKey = body.avatarKey;
    } else {
      return "avatarKey must be a key returned by the upload endpoint, or null";
    }
  }

  if (Object.keys(changes.set).length + changes.remove.length === 0) {
    return "At least one profile field is required";
  }
  return changes;
}

/**
 * Update Profile
 *
 * Applies the validated changes to Cognito (names) and the users table, then
 * returns the profile in the same shape as GET /staff/me.
 *
 * @param event The API Gateway event
 * @param config The resolved configuration
 * @param userId The caller
 * @returns A 200 response with the updated profile, or a 4xx error
 */
async function updateProfile(
  event: APIGatewayProxyEvent,
  config: Config,
  userId: string,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<Record<string, unknown>>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const changes = validateChanges(body, userId);
  if (typeof changes === "string") {
    return jsonResponse(event, 400, { message: changes });
  }

  const current = await dynamodb.send(
    new GetCommand({
      TableName: config.usersTable,
      Key: { userId },
      ConsistentRead: true,
    }),
  );
  if (!current.Item) {
    return jsonResponse(event, 404, { message: "Profile not found" });
  }
  const previousKey = current.Item.avatarKey as string | undefined;

  // A picture is only accepted once it has really been uploaded, and it must
  // still satisfy the type and size limits the upload policy enforced.
  if (typeof changes.avatarKey === "string") {
    try {
      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: config.bucket,
          Key: changes.avatarKey,
        }),
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

  if (changes.cognitoAttributes.length > 0) {
    // With email sign-in the Cognito username is the sub; prefer the claim.
    const claims = (
      event.requestContext.authorizer as {
        claims?: Record<string, string>;
      }
    )?.claims;
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: config.staffUserPoolId,
        Username: claims?.["cognito:username"] ?? userId,
        UserAttributes: changes.cognitoAttributes,
      }),
    );
  }

  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = {
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
        TableName: config.usersTable,
        Key: { userId },
        UpdateExpression:
          `SET ${assignments.join(", ")}` +
          (changes.remove.length > 0
            ? ` REMOVE ${changes.remove.map((f) => `#${f}`).join(", ")}`
            : ""),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(userId)",
        ReturnValues: "ALL_NEW",
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return jsonResponse(event, 404, { message: "Profile not found" });
    }
    throw error;
  }

  // Clean up the replaced picture. Failing to delete only leaves an orphan.
  if (
    previousKey &&
    changes.avatarKey !== undefined &&
    previousKey !== changes.avatarKey
  ) {
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: previousKey }),
      );
    } catch (error) {
      console.error("Failed to delete previous profile picture", { error });
    }
  }

  return jsonResponse(
    event,
    200,
    await withAvatarUrl(updated.Attributes as Record<string, unknown>),
  );
}

/**
 * Create Avatar Upload
 *
 * Returns a presigned POST for one picture. The signed policy limits the file
 * to 5 MB and to the declared image type, and pins the key under the caller's
 * own prefix. The client then PATCHes /staff/me with the returned key.
 *
 * @param event The API Gateway event
 * @param config The resolved configuration
 * @param userId The caller
 * @returns A 200 response with the upload URL, form fields, and key
 */
async function createAvatarUpload(
  event: APIGatewayProxyEvent,
  config: Config,
  userId: string,
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

  const key = `${avatarKeyPrefix(userId)}${randomUUID()}`;
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
