import { dynamodb } from "../shared/dynamodb";
import { jsonResponse } from "../shared/http";
import { getCallerUserId } from "../shared/authorization";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeEmail, parseJsonBody } from "../shared/validation";
import { isAccessError, loadOrganizationAccess } from "../shared/organizations";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type {
  CognitoUserAttribute,
  InviteOrganizationStaffRequest,
} from "../shared/types";

/**
 * Cognito Client
 *
 * Shared client used to look up or create the invited staff account.
 */
const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION,
});

/**
 * Maximum number of locations a single invitation may assign.
 */
const MAX_LOCATIONS_PER_INVITE = 25;

/**
 * Config
 *
 * Table names and user pool ID the resolver reads from the environment.
 */
interface Config {
  usersTable: string;
  locationsTable: string;
  staffUserPoolId: string;
  assignmentsTable: string;
  membershipsTable: string;
  organizationsTable: string;
}

/**
 * StaffAccount
 *
 * The Cognito identity of the invited staff member.
 */
interface StaffAccount {
  userId: string;
  status: "ACTIVE" | "INVITED";
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
    locationsTable: process.env.LOCATIONS_TABLE_NAME,
    staffUserPoolId: process.env.STAFF_USER_POOL_ID,
    assignmentsTable: process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME,
    membershipsTable: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
    organizationsTable: process.env.ORGANIZATIONS_TABLE_NAME,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error(
      "Invite staff Lambda is missing required environment configuration",
    );
  }
  return config as Config;
}

/**
 * Validates the locationIds array from the request body: between 1 and 25
 * non-empty strings with no duplicates.
 *
 * @param value The raw locationIds value
 * @returns The trimmed location IDs, or an error message to return as a 400
 */
function validateLocationIds(value: unknown): string[] | string {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_LOCATIONS_PER_INVITE ||
    value.some((id) => typeof id !== "string" || !id.trim())
  ) {
    return `locationIds must contain between 1 and ${MAX_LOCATIONS_PER_INVITE} location IDs`;
  }
  const locationIds = [...new Set(value.map((id: string) => id.trim()))];
  if (locationIds.length !== value.length) {
    return "locationIds must not contain duplicates";
  }
  return locationIds;
}

/**
 * Finds the staff account for an email in Cognito, creating it when it does
 * not exist yet. Newly created users receive their temporary password by
 * email.
 *
 * @param staffUserPoolId The staff user pool ID
 * @param email The normalized email address
 * @returns The account's sub and whether it is already confirmed
 */
async function findOrCreateStaffAccount(
  staffUserPoolId: string,
  email: string,
): Promise<StaffAccount> {
  let attributes: CognitoUserAttribute[] | undefined;
  let cognitoStatus: string | undefined;

  try {
    const existing = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: staffUserPoolId, Username: email }),
    );
    attributes = existing.UserAttributes;
    cognitoStatus = existing.UserStatus;
  } catch (error) {
    if ((error as { name?: string }).name !== "UserNotFoundException") {
      throw error;
    }
  }

  if (!attributes) {
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: staffUserPoolId,
        Username: email,
        UserAttributes: [{ Name: "email", Value: email }],
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
    attributes = created.User?.Attributes;
    cognitoStatus = created.User?.UserStatus;
  }

  const userId = attributes?.find(({ Name }) => Name === "sub")?.Value;
  if (!userId) {
    throw new Error("Cognito staff user is missing its sub attribute");
  }

  return {
    userId,
    status: cognitoStatus === "CONFIRMED" ? "ACTIVE" : "INVITED",
  };
}

/**
 * InviteOrganizationStaffResolver Handler
 *
 * Handles POST /organizations/{organizationId}/staff. An organization admin
 * invites a staff member by email and assigns them to one or more of the
 * organization's locations. The Cognito account is created if needed, then
 * the user profile, membership, and location assignments are upserted.
 *
 * @param event The API Gateway event containing the request details
 * and authorizer claims.
 * @returns A 201 response describing the invitation, or an error response.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const callerUserId = getCallerUserId(event);
  const organizationId = event.pathParameters?.organizationId;

  if (!callerUserId) {
    return jsonResponse(event, 401, { message: "Unauthorized" });
  }
  if (!organizationId) {
    return jsonResponse(event, 400, {
      message: "organizationId path parameter is required",
    });
  }

  const config = loadConfig();

  /**
   * Organization Access Check
   *
   * The caller must be an active admin and the organization must be active.
   */
  const access = await loadOrganizationAccess(
    event,
    callerUserId,
    organizationId,
    {
      organizationsTable: config.organizationsTable,
      membershipsTable: config.membershipsTable,
      allowedRoles: ["ADMIN"],
    },
  );
  if (isAccessError(access)) return access;

  /**
   * Request Body Validation
   */
  const body = parseJsonBody<InviteOrganizationStaffRequest>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return jsonResponse(event, 400, {
      message: "A valid email address is required",
    });
  }

  const locationIds = validateLocationIds(body.locationIds);
  if (typeof locationIds === "string") {
    return jsonResponse(event, 400, { message: locationIds });
  }

  /**
   * Location Ownership Check
   *
   * Every requested location must belong to this organization.
   */
  const locations = await Promise.all(
    locationIds.map((locationId) =>
      dynamodb.send(
        new GetCommand({
          TableName: config.locationsTable,
          Key: { organizationId, locationId },
          ConsistentRead: true,
        }),
      ),
    ),
  );
  if (locations.some((result) => !result.Item)) {
    return jsonResponse(event, 400, {
      message: "Every location must belong to the requested organization",
    });
  }

  /**
   * Resolve the Staff Account
   */
  const account = await findOrCreateStaffAccount(config.staffUserPoolId, email);
  const { userId, status } = account;

  // Admins keep their role; re-inviting one as staff is a conflict.
  const existingMembership = await dynamodb.send(
    new GetCommand({
      TableName: config.membershipsTable,
      Key: { organizationId, userId },
      ConsistentRead: true,
    }),
  );
  if (existingMembership.Item?.role === "ADMIN") {
    return jsonResponse(event, 409, {
      message: "This user is already an organization admin",
    });
  }

  /**
   * Upsert Profile, Membership, and Assignments
   *
   * Each write preserves createdAt on existing items so a re-invite refreshes
   * status and assignments without rewriting history.
   */
  const now = new Date().toISOString();

  await dynamodb.send(
    new UpdateCommand({
      TableName: config.usersTable,
      Key: { userId },
      UpdateExpression:
        "SET #email = :email, #userPoolType = :userPoolType, #createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now",
      ExpressionAttributeNames: {
        "#email": "email",
        "#userPoolType": "userPoolType",
        "#createdAt": "createdAt",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":email": email,
        ":userPoolType": "STAFF",
        ":now": now,
      },
    }),
  );

  await dynamodb.send(
    new UpdateCommand({
      TableName: config.membershipsTable,
      Key: { organizationId, userId },
      UpdateExpression:
        "SET #email = :email, #role = :role, #status = :status, #createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now",
      ExpressionAttributeNames: {
        "#email": "email",
        "#role": "role",
        "#status": "status",
        "#createdAt": "createdAt",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":email": email,
        ":role": "STAFF",
        ":status": status,
        ":now": now,
      },
    }),
  );

  await Promise.all(
    locationIds.map((locationId) =>
      dynamodb.send(
        new UpdateCommand({
          TableName: config.assignmentsTable,
          Key: { userId, locationId },
          UpdateExpression:
            "SET #organizationId = :organizationId, #status = :status, #createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now",
          ExpressionAttributeNames: {
            "#organizationId": "organizationId",
            "#status": "status",
            "#createdAt": "createdAt",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":organizationId": organizationId,
            ":status": status,
            ":now": now,
          },
        }),
      ),
    ),
  );

  return jsonResponse(event, 201, {
    userId,
    email,
    organizationId,
    role: "STAFF",
    status,
    locationIds,
  });
};
