import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const region = process.env.AWS_REGION;
const cognito = new CognitoIdentityProviderClient({ region });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

/**
 * CognitoAuthorizerClaims
 * 
 * This interface represents the structure of the claims object that is 
 * expected to be present in the authorizer context of an API Gateway event
 * when using Cognito as the authorizer.
 */
interface CognitoAuthorizerClaims {
  claims?: {
    sub?: string;
  };
}

interface InviteRequest {
  email?: unknown;
  locationIds?: unknown;
}

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGIN ?? "")
    .split(",")
    .filter(Boolean),
);

function response(
  statusCode: number,
  body: Record<string, unknown>,
  origin?: string,
): APIGatewayProxyResult {
  const allowedOrigin = origin && allowedOrigins.has(origin) ? origin : "null";
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowedOrigin,
      Vary: "Origin",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
      "Access-Control-Allow-Methods": "OPTIONS,POST",
    },
    body: JSON.stringify(body),
  };
}

/**
 * InviteOrganizationStaffResolver Handler
 *
 * This Lambda function is responsible for inviting a staff member to an
 * organization. It checks if the caller is an organization admin, validates the request
 * body, creates or retrieves the staff user in Cognito, and updates the necessary
 * DynamoDB tables to reflect the invitation.
 *
 * @param event The APIGatewayProxyEvent containing the request details,
 * including the path parameters and request body.
 * @returns An APIGatewayProxyResult indicating the outcome of the invite
 * operation,
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  // Extract the caller's user ID and the organization ID from the event
  const claims = event.requestContext.authorizer as CognitoAuthorizerClaims | undefined;
  const callerUserId = claims?.claims?.sub;
  const organizationId = event.pathParameters?.organizationId;
  const requestOrigin = event.headers.origin ?? event.headers.Origin;
  const reply = (statusCode: number, body: Record<string, unknown>) =>
    response(statusCode, body, requestOrigin);

  if (!callerUserId) return reply(401, { message: "Unauthorized" });
  if (!organizationId) {
    return reply(400, {
      message: "organizationId path parameter is required",
    });
  }

  const tableNames = {
    users: process.env.USERS_TABLE_NAME,
    organizations: process.env.ORGANIZATIONS_TABLE_NAME,
    locations: process.env.LOCATIONS_TABLE_NAME,
    assignments: process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME,
    memberships: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
  };
  const staffUserPoolId = process.env.STAFF_USER_POOL_ID;
  if (Object.values(tableNames).some((name) => !name) || !staffUserPoolId) {
    throw new Error(
      "Invite staff Lambda is missing required environment configuration",
    );
  }

  const membershipResult = await dynamodb.send(
    new GetCommand({
      TableName: tableNames.memberships,
      Key: { organizationId, userId: callerUserId },
      ConsistentRead: true,
    }),
  );
  const callerMembership = membershipResult.Item;
  if (
    callerMembership?.role !== "ADMIN" ||
    callerMembership.status !== "ACTIVE"
  ) {
    return reply(403, { message: "Organization admin access required" });
  }

  const organizationResult = await dynamodb.send(
    new GetCommand({
      TableName: tableNames.organizations,
      Key: { organizationId },
      ConsistentRead: true,
    }),
  );
  if (!organizationResult.Item) {
    return reply(404, { message: "Organization not found" });
  }

  let body: InviteRequest;
  try {
    body = JSON.parse(event.body ?? "") as InviteRequest;
  } catch {
    return reply(400, { message: "Request body must be valid JSON" });
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply(400, { message: "A valid email address is required" });
  }

  if (
    !Array.isArray(body.locationIds) ||
    body.locationIds.length === 0 ||
    body.locationIds.length > 25 ||
    body.locationIds.some(
      (locationId) => typeof locationId !== "string" || !locationId.trim(),
    )
  ) {
    return reply(400, {
      message: "locationIds must contain between 1 and 25 location IDs",
    });
  }

  const locationIds = [
    ...new Set(body.locationIds.map((locationId) => locationId.trim())),
  ];
  if (locationIds.length !== body.locationIds.length) {
    return reply(400, {
      message: "locationIds must not contain duplicates",
    });
  }

  const locations = await Promise.all(
    locationIds.map((locationId) =>
      dynamodb.send(
        new GetCommand({
          TableName: tableNames.locations,
          Key: { organizationId, locationId },
          ConsistentRead: true,
        }),
      ),
    ),
  );
  if (locations.some((result) => !result.Item)) {
    return reply(400, {
      message: "Every location must belong to the requested organization",
    });
  }

  let userAttributes: Array<{ Name?: string; Value?: string }> | undefined;
  let userStatus: string | undefined;
  try {
    const existingUser = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: staffUserPoolId, Username: email }),
    );
    userAttributes = existingUser.UserAttributes;
    userStatus = existingUser.UserStatus;
  } catch (error) {
    if ((error as { name?: string }).name !== "UserNotFoundException")
      throw error;
  }

  if (!userAttributes) {
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: staffUserPoolId,
        Username: email,
        UserAttributes: [{ Name: "email", Value: email }],
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
    userAttributes = created.User?.Attributes;
    userStatus = created.User?.UserStatus;
  }

  const userId = userAttributes?.find(({ Name }) => Name === "sub")?.Value;
  if (!userId)
    throw new Error("Cognito staff user is missing its sub attribute");

  const existingMembership = await dynamodb.send(
    new GetCommand({
      TableName: tableNames.memberships,
      Key: { organizationId, userId },
      ConsistentRead: true,
    }),
  );
  if (existingMembership.Item?.role === "ADMIN") {
    return reply(409, {
      message: "This user is already an organization admin",
    });
  }

  const now = new Date().toISOString();
  const status = userStatus === "CONFIRMED" ? "ACTIVE" : "INVITED";

  await dynamodb.send(
    new UpdateCommand({
      TableName: tableNames.users,
      Key: { userId },
      UpdateExpression:
        "SET #email = :email, #createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now",
      ExpressionAttributeNames: {
        "#email": "email",
        "#createdAt": "createdAt",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: { ":email": email, ":now": now },
    }),
  );

  await dynamodb.send(
    new UpdateCommand({
      TableName: tableNames.memberships,
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
          TableName: tableNames.assignments,
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

  return reply(201, {
    userId,
    email,
    organizationId,
    role: "STAFF",
    status,
    locationIds,
  });
};
