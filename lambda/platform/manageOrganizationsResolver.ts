import { randomUUID } from "node:crypto";
import { jsonResponse } from "../shared/http";
import { authorizePlatformAdmin } from "../shared/authorization";
import { normalizeEmail, parseJsonBody } from "../shared/validation";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  buildUpdateExpression,
  dynamodb,
  isConditionalCheckFailed,
  scanAll,
} from "../shared/dynamodb";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type {
  CognitoUserAttribute,
  CreateOrganizationRequest,
} from "../shared/types";

/**
 * Cognito Client
 *
 * Shared client used to provision the initial admin of a new organization.
 */
const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION,
});

/**
 * Config
 *
 * Table names and user pool ID the resolver reads from the environment.
 */
interface Config {
  usersTable: string;
  staffUserPoolId: string;
  membershipsTable: string;
  organizationsTable: string;
}

/**
 * OrganizationUpdates
 *
 * The fields a platform admin may change on an existing organization.
 */
interface OrganizationUpdates {
  name?: string;
  status?: "ACTIVE" | "INACTIVE";
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
    staffUserPoolId: process.env.STAFF_USER_POOL_ID,
    membershipsTable: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
    organizationsTable: process.env.ORGANIZATIONS_TABLE_NAME,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error(
      "Manage organizations Lambda is missing table or pool configuration",
    );
  }
  return config as Config;
}

/**
 * Platform ManageOrganizationsResolver Handler
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
  // Only allowlisted platform admins may reach any of these routes.
  const authorizationError = authorizePlatformAdmin(event);
  if (authorizationError) return authorizationError;

  const config = loadConfig();
  const organizationId = event.pathParameters?.organizationId;

  /**
   * Route Dispatch
   *
   * Collection routes have no organizationId in the path; item routes do.
   */
  if (!organizationId) {
    switch (event.httpMethod) {
      case "GET":
        return listOrganizations(event, config);
      case "POST":
        return createOrganization(event, config);
      default:
        return jsonResponse(event, 405, { message: "Method not allowed" });
    }
  }

  switch (event.httpMethod) {
    case "GET":
      return getOrganization(event, config, organizationId);
    case "PATCH":
      return updateOrganization(event, config, organizationId);
    case "DELETE":
      return deleteOrganization(event, config, organizationId);
    default:
      return jsonResponse(event, 405, { message: "Method not allowed" });
  }
};

/**
 * List Organizations
 *
 * Returns every organization on the platform.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @returns A 200 response with the organizations array
 */
async function listOrganizations(
  event: APIGatewayProxyEvent,
  config: Config,
): Promise<APIGatewayProxyResult> {
  const organizations = await scanAll<Record<string, unknown>>(
    config.organizationsTable,
  );
  return jsonResponse(event, 200, { organizations });
}

/**
 * Get Organization
 *
 * Returns a single organization by ID.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param organizationId The organization to retrieve
 * @returns A 200 response with the organization, or 404 if missing
 */
async function getOrganization(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: config.organizationsTable,
      Key: { organizationId },
      ConsistentRead: true,
    }),
  );
  if (!result.Item) {
    return jsonResponse(event, 404, { message: "Organization not found" });
  }
  return jsonResponse(event, 200, { organization: result.Item });
}

/**
 * Update Organization
 *
 * Validates the request body and applies name and/or status changes.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param organizationId The organization to update
 * @returns A 200 response with the updated organization, or a 4xx error
 */
async function updateOrganization(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<{ name?: unknown; status?: unknown }>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const updates: OrganizationUpdates = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) {
      return jsonResponse(event, 400, {
        message: "name must contain between 1 and 120 characters",
      });
    }
    updates.name = name;
  }

  if (body.status !== undefined) {
    if (body.status !== "ACTIVE" && body.status !== "INACTIVE") {
      return jsonResponse(event, 400, {
        message: "status must be ACTIVE or INACTIVE",
      });
    }
    updates.status = body.status;
  }

  if (Object.keys(updates).length === 0) {
    return jsonResponse(event, 400, {
      message: "At least one of name or status is required",
    });
  }

  return applyOrganizationUpdates(event, config, organizationId, updates);
}

/**
 * Delete Organization
 *
 * Soft-deletes an organization by marking it INACTIVE. Memberships,
 * locations, and assignments are retained.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param organizationId The organization to deactivate
 * @returns A 200 response with the updated organization, or 404 if missing
 */
async function deleteOrganization(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  return applyOrganizationUpdates(event, config, organizationId, {
    status: "INACTIVE",
  });
}

/**
 * Apply Organization Updates
 *
 * Writes a set of field changes to an existing organization and returns the
 * new item. A failed condition check means the organization does not exist.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param organizationId The organization to update
 * @param updates The fields to set
 * @returns A 200 response with the updated organization, or 404 if missing
 */
async function applyOrganizationUpdates(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
  updates: OrganizationUpdates,
): Promise<APIGatewayProxyResult> {
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: config.organizationsTable,
        Key: { organizationId },
        ...buildUpdateExpression(updates as Record<string, string>),
        ConditionExpression: "attribute_exists(organizationId)",
        ReturnValues: "ALL_NEW",
      }),
    );
    return jsonResponse(event, 200, { organization: result.Attributes });
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return jsonResponse(event, 404, { message: "Organization not found" });
    }
    throw error;
  }
}

/**
 * Create Organization
 *
 * Creates a new organization along with its initial admin. The admin is
 * created in the staff Cognito user pool, then the organization, user
 * profile, and ADMIN membership are written in a single transaction. If the
 * transaction fails, the Cognito user is removed again.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @returns A 201 response with the organization and admin, or a 4xx error
 */
async function createOrganization(
  event: APIGatewayProxyEvent,
  config: Config,
): Promise<APIGatewayProxyResult> {
  /**
   * Request Body Validation
   */
  const body = parseJsonBody<CreateOrganizationRequest>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const organizationName =
    typeof body.organizationName === "string"
      ? body.organizationName.trim()
      : "";
  if (!organizationName || organizationName.length > 120) {
    return jsonResponse(event, 400, {
      message: "organizationName must contain between 1 and 120 characters",
    });
  }

  const adminEmail = normalizeEmail(body.adminEmail);
  if (!adminEmail) {
    return jsonResponse(event, 400, {
      message: "A valid adminEmail is required",
    });
  }

  const now = new Date().toISOString();
  const organizationId = randomUUID();
  let cognitoUserCreated = false;

  try {
    /**
     * Create the Admin in Cognito
     *
     * Cognito emails the temporary password. The user's sub becomes the
     * userId used across every DynamoDB table.
     */
    const createdUser = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: config.staffUserPoolId,
        Username: adminEmail,
        UserAttributes: [{ Name: "email", Value: adminEmail }],
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
    cognitoUserCreated = true;

    const adminUserId = createdUser.User?.Attributes?.find(
      (attribute: CognitoUserAttribute) => attribute.Name === "sub",
    )?.Value;
    if (!adminUserId) {
      throw new Error("Created Cognito admin is missing its sub attribute");
    }

    const membershipStatus =
      createdUser.User?.UserStatus === "CONFIRMED" ? "ACTIVE" : "INVITED";

    /**
     * Write Organization, Profile, and Membership Atomically
     *
     * All three succeed or none do, so a half-created organization can never
     * exist in DynamoDB.
     */
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: config.organizationsTable,
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
              TableName: config.usersTable,
              Key: { userId: adminUserId },
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
              TableName: config.membershipsTable,
              Item: {
                organizationId,
                userId: adminUserId,
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

    return jsonResponse(event, 201, {
      organization: { organizationId, name: organizationName },
      admin: {
        userId: adminUserId,
        email: adminEmail,
        role: "ADMIN",
        status: membershipStatus,
      },
      locations: [],
    });
  } catch (error) {
    if ((error as { name?: string }).name === "UsernameExistsException") {
      return jsonResponse(event, 409, {
        message: "An account with this email already exists in the staff pool",
      });
    }

    /**
     * Roll Back the Cognito User
     *
     * The DynamoDB transaction failed after the Cognito user was created, so
     * remove the user to keep Cognito and DynamoDB consistent.
     */
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
