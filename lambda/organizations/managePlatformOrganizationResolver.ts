import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "node:crypto";
import { dynamodb, scanAll } from "../shared/dynamodb";
import { jsonResponse as response } from "../shared/http";
import { authorizePlatformAdmin } from "../shared/authorization";
import { normalizeEmail, parseJsonBody } from "../shared/validation";

import type {
  CognitoUserAttribute,
  CreateOrganizationRequest,
} from "../shared/types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const region = process.env.AWS_REGION;
const cognito = new CognitoIdentityProviderClient({ region });

interface Config {
  staffUserPoolId: string;
  usersTableName: string;
  organizationsTableName: string;
  membershipsTableName: string;
}

/**
 * ManagePlatformOrganizationResolver Handler
 *
 * Single Lambda for all platform-admin organization CRUD operations:
 *
 * - GET    /platform/organizations                  list organizations
 * - POST   /platform/organizations                  create organization + admin
 * - GET    /platform/organizations/{organizationId} retrieve one organization
 * - PATCH  /platform/organizations/{organizationId} update name or status
 * - DELETE /platform/organizations/{organizationId} soft-delete (INACTIVE)
 *
 * @param event The API Gateway event containing the request details
 * and authorizer claims.
 * @returns An APIGatewayProxyResult for the requested operation.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const authorizationError = authorizePlatformAdmin(event);
  if (authorizationError) return authorizationError;

  const config: Config = {
    staffUserPoolId: process.env.STAFF_USER_POOL_ID ?? "",
    usersTableName: process.env.USERS_TABLE_NAME ?? "",
    organizationsTableName: process.env.ORGANIZATIONS_TABLE_NAME ?? "",
    membershipsTableName: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME ?? "",
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error(
      "Manage organization Lambda is missing table or pool configuration",
    );
  }

  const organizationId = event.pathParameters?.organizationId;

  if (!organizationId) {
    switch (event.httpMethod) {
      case "GET":
        return handleList(event, config);
      case "POST":
        return handleCreate(event, config);
      default:
        return response(event, 405, { message: "Method not allowed" });
    }
  }

  switch (event.httpMethod) {
    case "GET":
      return handleGet(event, config, organizationId);
    case "PATCH":
      return handleUpdate(event, config, organizationId);
    case "DELETE":
      return handleDelete(event, config, organizationId);
    default:
      return response(event, 405, { message: "Method not allowed" });
  }
};

/**
 * Lists every organization on the platform.
 */
async function handleList(
  event: APIGatewayProxyEvent,
  config: Config,
): Promise<APIGatewayProxyResult> {
  const organizations = await scanAll<Record<string, unknown>>(
    config.organizationsTableName,
  );
  return response(event, 200, { organizations });
}

/**
 * Retrieves a single organization by ID.
 */
async function handleGet(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: config.organizationsTableName,
      Key: { organizationId },
      ConsistentRead: true,
    }),
  );
  if (!result.Item) {
    return response(event, 404, { message: "Organization not found" });
  }
  return response(event, 200, { organization: result.Item });
}

/**
 * Updates the name and/or status of an organization.
 */
async function handleUpdate(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<{ name?: unknown; status?: unknown }>(event);
  if (!body) {
    return response(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const updates: { name?: string; status?: "ACTIVE" | "INACTIVE" } = {};
  if (body.name !== undefined) {
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.trim().length > 120
    ) {
      return response(event, 400, {
        message: "name must contain between 1 and 120 characters",
      });
    }
    updates.name = body.name.trim();
  }
  if (body.status !== undefined) {
    if (body.status !== "ACTIVE" && body.status !== "INACTIVE") {
      return response(event, 400, {
        message: "status must be ACTIVE or INACTIVE",
      });
    }
    updates.status = body.status;
  }
  if (Object.keys(updates).length === 0) {
    return response(event, 400, {
      message: "At least one of name or status is required",
    });
  }

  return applyUpdates(event, config, organizationId, updates);
}

/**
 * Soft-deletes an organization by marking it INACTIVE.
 */
async function handleDelete(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  return applyUpdates(event, config, organizationId, { status: "INACTIVE" });
}

/**
 * Writes a set of field updates to an existing organization.
 */
async function applyUpdates(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
  updates: Record<string, string>,
): Promise<APIGatewayProxyResult> {
  const expressionNames: Record<string, string> = {
    "#updatedAt": "updatedAt",
  };
  const expressionValues: Record<string, string> = {
    ":updatedAt": new Date().toISOString(),
  };
  const expressions = ["#updatedAt = :updatedAt"];
  for (const [field, value] of Object.entries(updates)) {
    expressionNames[`#${field}`] = field;
    expressionValues[`:${field}`] = value;
    expressions.push(`#${field} = :${field}`);
  }

  let result;
  try {
    result = await dynamodb.send(
      new UpdateCommand({
        TableName: config.organizationsTableName,
        Key: { organizationId },
        UpdateExpression: `SET ${expressions.join(", ")}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ConditionExpression: "attribute_exists(organizationId)",
        ReturnValues: "ALL_NEW",
      }),
    );
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
      return response(event, 404, { message: "Organization not found" });
    }
    throw error;
  }
  return response(event, 200, { organization: result.Attributes });
}

/**
 * Creates a new organization along with its initial admin. The admin is
 * created in the staff Cognito user pool, and the organization, user profile,
 * and ADMIN membership are written in a single transaction. If the transaction
 * fails, the Cognito user is removed again.
 */
async function handleCreate(
  event: APIGatewayProxyEvent,
  config: Config,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<CreateOrganizationRequest>(event);
  if (!body) {
    return response(event, 400, { message: "Request body must be valid JSON" });
  }

  const organizationName =
    typeof body.organizationName === "string"
      ? body.organizationName.trim()
      : "";
  const adminEmail = normalizeEmail(body.adminEmail);

  if (!organizationName || organizationName.length > 120) {
    return response(event, 400, {
      message: "organizationName must contain between 1 and 120 characters",
    });
  }
  if (!adminEmail) {
    return response(event, 400, { message: "A valid adminEmail is required" });
  }

  const organizationId = randomUUID();
  const now = new Date().toISOString();
  let cognitoUserCreated = false;

  try {
    const createdUser = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: config.staffUserPoolId,
        Username: adminEmail,
        UserAttributes: [{ Name: "email", Value: adminEmail }],
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
    cognitoUserCreated = true;
    const createdAdminUserId = createdUser.User?.Attributes?.find(
      (attribute: CognitoUserAttribute) => attribute.Name === "sub",
    )?.Value;

    if (!createdAdminUserId) {
      throw new Error("Created Cognito admin is missing its sub attribute");
    }

    const membershipStatus =
      createdUser.User?.UserStatus === "CONFIRMED" ? "ACTIVE" : "INVITED";

    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: config.organizationsTableName,
              Item: {
                organizationId,
                name: organizationName,
                status: "ACTIVE",
                createdAt: now,
                updatedAt: now,
              },
              ConditionExpression: "attribute_not_exists(organizationId)",
            },
          },
          {
            Update: {
              TableName: config.usersTableName,
              Key: { userId: createdAdminUserId },
              UpdateExpression:
                "SET #email = :email, #userPoolType = :userPoolType, #status = :status, #createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now",
              ExpressionAttributeNames: {
                "#email": "email",
                "#userPoolType": "userPoolType",
                "#status": "status",
                "#createdAt": "createdAt",
                "#updatedAt": "updatedAt",
              },
              ExpressionAttributeValues: {
                ":email": adminEmail,
                ":userPoolType": "STAFF",
                ":status": membershipStatus,
                ":now": now,
              },
            },
          },
          {
            Put: {
              TableName: config.membershipsTableName,
              Item: {
                organizationId,
                userId: createdAdminUserId,
                email: adminEmail,
                role: "ADMIN",
                status: membershipStatus,
                createdAt: now,
                updatedAt: now,
              },
              ConditionExpression:
                "attribute_not_exists(organizationId) AND attribute_not_exists(userId)",
            },
          },
        ],
      }),
    );

    return response(event, 201, {
      organization: {
        organizationId,
        name: organizationName,
      },
      admin: {
        userId: createdAdminUserId,
        email: adminEmail,
        role: "ADMIN",
        status: membershipStatus,
      },
      locations: [],
    });
  } catch (error) {
    if ((error as { name?: string }).name === "UsernameExistsException") {
      return response(event, 409, {
        message: "An account with this email already exists in the staff pool",
      });
    }

    if (cognitoUserCreated) {
      try {
        await cognito.send(
          new AdminDeleteUserCommand({
            UserPoolId: config.staffUserPoolId,
            Username: adminEmail,
          }),
        );
      } catch (cleanupError) {
        console.error(
          "Could not remove Cognito user after organization creation failed",
          cleanupError,
        );
      }
    }
    throw error;
  }
}
