import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type { CognitoAuthorizerClaims } from "../shared/types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

type UserPoolType = "STAFF" | "PATIENT";
type UserStatus = "ACTIVE" | "DISABLED";

const cognito = new CognitoIdentityProviderClient({});
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const platformAdminUserIds = new Set(
  (process.env.PLATFORM_ADMIN_USER_IDS ?? "").split(",").filter(Boolean),
);
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
);

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

function poolId(type: UserPoolType): string {
  const id =
    type === "STAFF"
      ? process.env.STAFF_USER_POOL_ID
      : process.env.PATIENT_USER_POOL_ID;
  if (!id) throw new Error(`${type}_USER_POOL_ID is required`);
  return id;
}

async function findCognitoUser(
  userId: string,
  preferredType?: UserPoolType,
): Promise<{ user: UserType; type: UserPoolType } | undefined> {
  const types: UserPoolType[] = preferredType
    ? [preferredType]
    : ["STAFF", "PATIENT"];
  const matches: { user: UserType; type: UserPoolType }[] = [];

  for (const type of types) {
    const result = await cognito.send(
      new ListUsersCommand({
        UserPoolId: poolId(type),
        Filter: `sub = "${userId}"`,
        Limit: 2,
      }),
    );
    for (const user of result.Users ?? []) matches.push({ user, type });
  }

  if (matches.length > 1) {
    throw new Error(`User ${userId} exists in multiple Cognito user pools`);
  }
  return matches[0];
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const claims = event.requestContext.authorizer as
    | CognitoAuthorizerClaims
    | undefined;
  const callerUserId = claims?.claims?.sub;
  if (!callerUserId) return response(event, 401, { message: "Unauthorized" });
  if (!platformAdminUserIds.has(callerUserId)) {
    return response(event, 403, { message: "Platform admin access required" });
  }

  const tableName = process.env.USERS_TABLE_NAME;
  if (!tableName) throw new Error("USERS_TABLE_NAME is required");

  if (event.httpMethod === "POST") {
    let body: {
      email?: unknown;
      userPoolType?: unknown;
      givenName?: unknown;
      familyName?: unknown;
    };
    try {
      body = JSON.parse(event.body ?? "") as typeof body;
    } catch {
      return response(event, 400, { message: "Request body must be valid JSON" });
    }

    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response(event, 400, { message: "A valid email is required" });
    }
    if (body.userPoolType !== "STAFF" && body.userPoolType !== "PATIENT") {
      return response(event, 400, {
        message: "userPoolType must be STAFF or PATIENT",
      });
    }
    if (body.givenName !== undefined && !validName(body.givenName)) {
      return response(event, 400, { message: "givenName must be 1-100 characters" });
    }
    if (body.familyName !== undefined && !validName(body.familyName)) {
      return response(event, 400, { message: "familyName must be 1-100 characters" });
    }

    const type = body.userPoolType;
    const userPoolId = poolId(type);
    let createdUsername: string | undefined;
    try {
      const result = await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            ...(validName(body.givenName)
              ? [{ Name: "given_name", Value: body.givenName.trim() }]
              : []),
            ...(validName(body.familyName)
              ? [{ Name: "family_name", Value: body.familyName.trim() }]
              : []),
          ],
          DesiredDeliveryMediums: ["EMAIL"],
        }),
      );
      createdUsername = result.User?.Username;
      const userId = result.User?.Attributes?.find(
        (attribute) => attribute.Name === "sub",
      )?.Value;
      if (!userId || !createdUsername) {
        throw new Error("Created Cognito user is missing its identity");
      }

      const now = new Date().toISOString();
      const user = {
        userId,
        email,
        ...(validName(body.givenName)
          ? { givenName: body.givenName.trim() }
          : {}),
        ...(validName(body.familyName)
          ? { familyName: body.familyName.trim() }
          : {}),
        userPoolType: type,
        status: "INVITED",
        createdAt: now,
        updatedAt: now,
      };
      await dynamodb.send(
        new PutCommand({
          TableName: tableName,
          Item: user,
          ConditionExpression: "attribute_not_exists(userId)",
        }),
      );
      return response(event, 201, { user });
    } catch (error) {
      if ((error as { name?: string }).name === "UsernameExistsException") {
        return response(event, 409, {
          message: "A user with this email already exists in the selected pool",
        });
      }
      if (createdUsername) {
        try {
          await cognito.send(
            new AdminDeleteUserCommand({
              UserPoolId: userPoolId,
              Username: createdUsername,
            }),
          );
        } catch (cleanupError) {
          console.error("Could not remove Cognito user after profile creation failed", cleanupError);
        }
      }
      throw error;
    }
  }

  const userId = event.pathParameters?.userId;
  if (!userId) return response(event, 400, { message: "userId is required" });

  const profileResult = await dynamodb.send(
    new GetCommand({
      TableName: tableName,
      Key: { userId },
      ConsistentRead: true,
    }),
  );
  const profile = profileResult.Item;
  if (!profile) return response(event, 404, { message: "User not found" });

  if (event.httpMethod === "GET") {
    return response(event, 200, { user: profile });
  }
  if (event.httpMethod !== "PATCH" && event.httpMethod !== "DELETE") {
    return response(event, 405, { message: "Method not allowed" });
  }

  const cognitoUser = await findCognitoUser(
    userId,
    profile.userPoolType as UserPoolType | undefined,
  );
  if (!cognitoUser?.user.Username) {
    return response(event, 409, {
      message: "Cognito account not found for this profile",
    });
  }

  let body: {
    email?: unknown;
    givenName?: unknown;
    familyName?: unknown;
    status?: unknown;
  } = {};
  if (event.httpMethod === "PATCH") {
    try {
      body = JSON.parse(event.body ?? "") as typeof body;
    } catch {
      return response(event, 400, { message: "Request body must be valid JSON" });
    }
  } else {
    body.status = "DISABLED";
  }

  const profileUpdates: Record<string, string> = {};
  const cognitoAttributes: { Name: string; Value: string }[] = [];
  if (body.email !== undefined) {
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response(event, 400, { message: "A valid email is required" });
    }
    profileUpdates.email = email;
    cognitoAttributes.push({ Name: "email", Value: email });
  }
  for (const [field, cognitoField, value] of [
    ["givenName", "given_name", body.givenName],
    ["familyName", "family_name", body.familyName],
  ] as const) {
    if (value === undefined) continue;
    if (!validName(value)) {
      return response(event, 400, {
        message: `${field} must be 1-100 characters`,
      });
    }
    profileUpdates[field] = value.trim();
    cognitoAttributes.push({ Name: cognitoField, Value: value.trim() });
  }
  if (body.status !== undefined) {
    if (body.status !== "ACTIVE" && body.status !== "DISABLED") {
      return response(event, 400, {
        message: "status must be ACTIVE or DISABLED",
      });
    }
    profileUpdates.status = body.status;
  }
  if (Object.keys(profileUpdates).length === 0) {
    return response(event, 400, {
      message: "At least one profile field or status is required",
    });
  }

  const userPoolId = poolId(cognitoUser.type);
  profileUpdates.userPoolType = cognitoUser.type;
  if (cognitoAttributes.length > 0) {
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: cognitoUser.user.Username,
        UserAttributes: cognitoAttributes,
      }),
    );
  }
  if (profileUpdates.status === "DISABLED") {
    await cognito.send(
      new AdminDisableUserCommand({
        UserPoolId: userPoolId,
        Username: cognitoUser.user.Username,
      }),
    );
  } else if (profileUpdates.status === "ACTIVE") {
    await cognito.send(
      new AdminEnableUserCommand({
        UserPoolId: userPoolId,
        Username: cognitoUser.user.Username,
      }),
    );
  }

  const expressionNames: Record<string, string> = { "#updatedAt": "updatedAt" };
  const expressionValues: Record<string, string> = {
    ":updatedAt": new Date().toISOString(),
  };
  const assignments = ["#updatedAt = :updatedAt"];
  for (const [field, value] of Object.entries(profileUpdates)) {
    expressionNames[`#${field}`] = field;
    expressionValues[`:${field}`] = value;
    assignments.push(`#${field} = :${field}`);
  }
  const updated = await dynamodb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { userId },
      UpdateExpression: `SET ${assignments.join(", ")}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
      ConditionExpression: "attribute_exists(userId)",
      ReturnValues: "ALL_NEW",
    }),
  );
  return response(event, 200, { user: updated.Attributes });
};