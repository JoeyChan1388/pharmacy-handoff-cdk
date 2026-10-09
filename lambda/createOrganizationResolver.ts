import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type {
  CognitoAuthorizerClaims,
  CognitoUserAttribute,
  CreateOrganizationRequest,
} from "./types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const region = process.env.AWS_REGION;
const cognito = new CognitoIdentityProviderClient({ region });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

/**
 * Platform Admin User IDs
 */
const platformAdminUserIds = new Set(
  (process.env.PLATFORM_ADMIN_USER_IDS ?? "").split(",").filter(Boolean),
);

/**
 * Allowed Origins
 */
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
);

/**
 * Creates a response object for the API Gateway
 *
 * @param event The API Gateway event
 * @param statusCode The HTTP status code
 * @param body The response body
 * @returns The API Gateway response object
 */
function response(
  event: APIGatewayProxyEvent,
  statusCode: number,
  body: Record<string, unknown>,
): APIGatewayProxyResult {
  const origin = event.headers.origin ?? event.headers.Origin;
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...(origin && allowedOrigins.has(origin)
        ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
        : {}),
    },
    body: JSON.stringify(body),
  };
}

/**
 * CreateOrganizationResolver Handler
 *
 * This Lambda function is responsible for creating a new organization.
 * It requires the user to be a platform admin, and it creates a new
 * organization in the organizations table, as well as a new user
 * profile for the organization admin in the users table.
 *
 * @param event The API Gateway event containing the request details
 * and authorizer claims.
 * @returns An APIGatewayProxyResult containing the created organization
 * and admin user details, or an error message.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const claims = event.requestContext.authorizer as
    | CognitoAuthorizerClaims
    | undefined;
  const callerUserId = claims?.claims?.sub;

  if (!callerUserId) {
    return response(event, 401, { message: "Unauthorized" });
  }
  if (!platformAdminUserIds.has(callerUserId)) {
    return response(event, 403, { message: "Platform admin access required" });
  }

  const staffUserPoolId = process.env.STAFF_USER_POOL_ID;
  const usersTableName = process.env.USERS_TABLE_NAME;
  const organizationsTableName = process.env.ORGANIZATIONS_TABLE_NAME;
  const membershipsTableName = process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME;
  if (
    !staffUserPoolId ||
    !usersTableName ||
    !organizationsTableName ||
    !membershipsTableName
  ) {
    throw new Error(
      "Create organization Lambda is missing table or pool configuration",
    );
  }

  let body: CreateOrganizationRequest;
  try {
    body = JSON.parse(event.body ?? "") as CreateOrganizationRequest;
  } catch {
    return response(event, 400, { message: "Request body must be valid JSON" });
  }

  const organizationName =
    typeof body.organizationName === "string"
      ? body.organizationName.trim()
      : "";
  const adminEmail =
    typeof body.adminEmail === "string"
      ? body.adminEmail.trim().toLowerCase()
      : "";

  if (!organizationName || organizationName.length > 120) {
    return response(event, 400, {
      message: "organizationName must contain between 1 and 120 characters",
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    return response(event, 400, { message: "A valid adminEmail is required" });
  }

  const organizationId = randomUUID();
  const now = new Date().toISOString();
  let createdAdminUserId: string | undefined;
  let cognitoUserCreated = false;

  try {
    const createdUser = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: staffUserPoolId,
        Username: adminEmail,
        UserAttributes: [{ Name: "email", Value: adminEmail }],
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
    cognitoUserCreated = true;
    createdAdminUserId = createdUser.User?.Attributes?.find(
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
              TableName: organizationsTableName,
              Item: {
                organizationId,
                name: organizationName,
                createdAt: now,
                updatedAt: now,
              },
              ConditionExpression: "attribute_not_exists(organizationId)",
            },
          },
          {
            Update: {
              TableName: usersTableName,
              Key: { userId: createdAdminUserId },
              UpdateExpression:
                "SET #email = :email, #createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now",
              ExpressionAttributeNames: {
                "#email": "email",
                "#createdAt": "createdAt",
                "#updatedAt": "updatedAt",
              },
              ExpressionAttributeValues: {
                ":email": adminEmail,
                ":now": now,
              },
            },
          },
          {
            Put: {
              TableName: membershipsTableName,
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
            UserPoolId: staffUserPoolId,
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
};
