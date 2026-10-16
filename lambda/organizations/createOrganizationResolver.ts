import {
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "node:crypto";
import { dynamodb } from "../shared/dynamodb";
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
  const authorizationError = authorizePlatformAdmin(event);
  if (authorizationError) return authorizationError;

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
                status: "ACTIVE",
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
