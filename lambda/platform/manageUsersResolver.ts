import { jsonResponse } from "../shared/http";
import { authorizePlatformAdmin } from "../shared/authorization";
import { buildUpdateExpression, dynamodb, scanAll } from "../shared/dynamodb";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  normalizeEmail,
  parseJsonBody,
  requiredText,
} from "../shared/validation";
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

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * Cognito Client
 *
 * Shared client used to manage accounts in the staff and patient pools.
 */
const cognito = new CognitoIdentityProviderClient({});

/**
 * Maximum length of a given or family name.
 */
const NAME_MAX_LENGTH = 100;

type UserPoolType = "STAFF" | "PATIENT";
type UserStatus = "ACTIVE" | "DISABLED";

/**
 * CognitoUserMatch
 *
 * A Cognito user together with the pool it was found in.
 */
interface CognitoUserMatch {
  user: UserType;
  type: UserPoolType;
}

/**
 * UserProfileBody
 *
 * The fields accepted when creating or updating a user.
 */
interface UserProfileBody {
  email?: unknown;
  status?: unknown;
  givenName?: unknown;
  familyName?: unknown;
  userPoolType?: unknown;
}

/**
 * ProfileChanges
 *
 * Validated updates split into what goes to DynamoDB and what goes to Cognito.
 */
interface ProfileChanges {
  profile: Record<string, string>;
  cognitoAttributes: { Name: string; Value: string }[];
}

/**
 * Resolves the Cognito user pool ID for the given pool type from the
 * environment, throwing if it is not configured.
 *
 * @param type The user pool type
 * @returns The user pool ID
 */
function poolId(type: UserPoolType): string {
  const id =
    type === "STAFF"
      ? process.env.STAFF_USER_POOL_ID
      : process.env.PATIENT_USER_POOL_ID;
  if (!id) throw new Error(`${type}_USER_POOL_ID is required`);
  return id;
}

/**
 * Looks up a Cognito user by sub across the staff and patient pools, or only
 * the preferred pool when known. Throws if the sub exists in more than one
 * pool.
 *
 * @param userId The Cognito sub to search for
 * @param preferredType Restrict the search to a single pool
 * @returns The matched user and its pool type, or undefined
 */
async function findCognitoUser(
  userId: string,
  preferredType?: UserPoolType,
): Promise<CognitoUserMatch | undefined> {
  const types: UserPoolType[] = preferredType
    ? [preferredType]
    : ["STAFF", "PATIENT"];
  const matches: CognitoUserMatch[] = [];

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

/**
 * Validates the editable profile fields in a request body and splits them
 * into DynamoDB profile updates and Cognito attribute updates.
 *
 * @param body The parsed request body
 * @returns The validated changes, or an error message to return as a 400
 */
function validateProfileChanges(
  body: UserProfileBody,
): ProfileChanges | string {
  const changes: ProfileChanges = { profile: {}, cognitoAttributes: [] };

  if (body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (!email) return "A valid email is required";
    changes.profile.email = email;
    changes.cognitoAttributes.push({ Name: "email", Value: email });
  }

  const nameFields = [
    ["givenName", "given_name", body.givenName],
    ["familyName", "family_name", body.familyName],
  ] as const;
  for (const [field, cognitoField, value] of nameFields) {
    if (value === undefined) continue;
    const name = requiredText(value, NAME_MAX_LENGTH);
    if (!name) return `${field} must be 1-${NAME_MAX_LENGTH} characters`;
    changes.profile[field] = name;
    changes.cognitoAttributes.push({ Name: cognitoField, Value: name });
  }

  if (body.status !== undefined) {
    if (body.status !== "ACTIVE" && body.status !== "DISABLED") {
      return "status must be ACTIVE or DISABLED";
    }
    changes.profile.status = body.status;
  }

  return changes;
}

/**
 * Platform ManageUsersResolver Handler
 *
 * Single Lambda for all platform-admin user CRUD operations:
 *
 * - GET    /platform/users           list users
 * - POST   /platform/users           create a Cognito account and profile
 * - GET    /platform/users/{userId}  retrieve one profile
 * - PATCH  /platform/users/{userId}  update profile and Cognito attributes
 * - DELETE /platform/users/{userId}  disable the account and profile
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

  const usersTable = process.env.USERS_TABLE_NAME;
  if (!usersTable) throw new Error("USERS_TABLE_NAME is required");

  const userId = event.pathParameters?.userId;

  /**
   * Route Dispatch
   *
   * Collection routes have no userId in the path; item routes do.
   */
  if (!userId) {
    switch (event.httpMethod) {
      case "GET":
        return listUsers(event, usersTable);
      case "POST":
        return createUser(event, usersTable);
      default:
        return jsonResponse(event, 405, { message: "Method not allowed" });
    }
  }

  switch (event.httpMethod) {
    case "GET":
      return getUser(event, usersTable, userId);
    case "PATCH":
      return updateUser(event, usersTable, userId);
    case "DELETE":
      return disableUser(event, usersTable, userId);
    default:
      return jsonResponse(event, 405, { message: "Method not allowed" });
  }
};

/**
 * List Users
 *
 * Returns every user profile on the platform.
 *
 * @param event The API Gateway event
 * @param usersTable The users table name
 * @returns A 200 response with the users array
 */
async function listUsers(
  event: APIGatewayProxyEvent,
  usersTable: string,
): Promise<APIGatewayProxyResult> {
  const users = await scanAll<Record<string, unknown>>(usersTable);
  return jsonResponse(event, 200, { users });
}

/**
 * Get User
 *
 * Returns a single user profile by ID.
 *
 * @param event The API Gateway event
 * @param usersTable The users table name
 * @param userId The user to retrieve
 * @returns A 200 response with the user, or 404 if missing
 */
async function getUser(
  event: APIGatewayProxyEvent,
  usersTable: string,
  userId: string,
): Promise<APIGatewayProxyResult> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: usersTable,
      Key: { userId },
      ConsistentRead: true,
    }),
  );
  if (!result.Item) {
    return jsonResponse(event, 404, { message: "User not found" });
  }
  return jsonResponse(event, 200, { user: result.Item });
}

/**
 * Create User
 *
 * Creates a Cognito account in the requested pool and a matching profile in
 * the users table. If the profile write fails, the Cognito account is removed
 * again.
 *
 * @param event The API Gateway event
 * @param usersTable The users table name
 * @returns A 201 response with the new profile, or a 4xx error
 */
async function createUser(
  event: APIGatewayProxyEvent,
  usersTable: string,
): Promise<APIGatewayProxyResult> {
  /**
   * Request Body Validation
   */
  const body = parseJsonBody<UserProfileBody>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }
  if (body.userPoolType !== "STAFF" && body.userPoolType !== "PATIENT") {
    return jsonResponse(event, 400, {
      message: "userPoolType must be STAFF or PATIENT",
    });
  }

  const changes = validateProfileChanges({
    email: body.email,
    givenName: body.givenName,
    familyName: body.familyName,
  });
  if (typeof changes === "string") {
    return jsonResponse(event, 400, { message: changes });
  }
  if (!changes.profile.email) {
    return jsonResponse(event, 400, { message: "A valid email is required" });
  }

  const type = body.userPoolType;
  const userPoolId = poolId(type);
  let createdUsername: string | undefined;

  try {
    /**
     * Create the Account in Cognito
     *
     * Cognito emails the temporary password. The user's sub becomes the
     * userId of the profile.
     */
    const result = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: changes.profile.email,
        UserAttributes: changes.cognitoAttributes,
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

    /**
     * Write the Profile
     */
    const now = new Date().toISOString();
    const user = {
      userId,
      ...changes.profile,
      userPoolType: type,
      status: "INVITED",
      createdAt: now,
      updatedAt: now,
    };
    await dynamodb.send(
      new PutCommand({
        TableName: usersTable,
        Item: user,
        ConditionExpression: "attribute_not_exists(userId)",
      }),
    );
    return jsonResponse(event, 201, { user });
  } catch (error) {
    if ((error as { name?: string }).name === "UsernameExistsException") {
      return jsonResponse(event, 409, {
        message: "A user with this email already exists in the selected pool",
      });
    }

    /**
     * Roll Back the Cognito Account
     *
     * The profile write failed after the account was created, so remove the
     * account to keep Cognito and DynamoDB consistent.
     */
    if (createdUsername) {
      try {
        await cognito.send(
          new AdminDeleteUserCommand({
            UserPoolId: userPoolId,
            Username: createdUsername,
          }),
        );
      } catch (cleanupError) {
        console.error(
          "Could not remove Cognito user after profile creation failed",
          cleanupError,
        );
      }
    }
    throw error;
  }
}

/**
 * Update User
 *
 * Validates the request body and applies profile changes to both Cognito and
 * the users table.
 *
 * @param event The API Gateway event
 * @param usersTable The users table name
 * @param userId The user to update
 * @returns A 200 response with the updated profile, or a 4xx error
 */
async function updateUser(
  event: APIGatewayProxyEvent,
  usersTable: string,
  userId: string,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<UserProfileBody>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const changes = validateProfileChanges(body);
  if (typeof changes === "string") {
    return jsonResponse(event, 400, { message: changes });
  }
  if (Object.keys(changes.profile).length === 0) {
    return jsonResponse(event, 400, {
      message: "At least one profile field or status is required",
    });
  }

  return applyUserChanges(event, usersTable, userId, changes);
}

/**
 * Disable User
 *
 * Soft-deletes a user by disabling the Cognito account and marking the
 * profile DISABLED. The profile and account are retained.
 *
 * @param event The API Gateway event
 * @param usersTable The users table name
 * @param userId The user to disable
 * @returns A 200 response with the updated profile, or a 4xx error
 */
async function disableUser(
  event: APIGatewayProxyEvent,
  usersTable: string,
  userId: string,
): Promise<APIGatewayProxyResult> {
  return applyUserChanges(event, usersTable, userId, {
    profile: { status: "DISABLED" },
    cognitoAttributes: [],
  });
}

/**
 * Apply User Changes
 *
 * Loads the profile and its Cognito account, pushes attribute and enabled
 * state changes to Cognito, then writes the profile updates to DynamoDB.
 *
 * @param event The API Gateway event
 * @param usersTable The users table name
 * @param userId The user to update
 * @param changes The validated changes to apply
 * @returns A 200 response with the updated profile, or a 4xx error
 */
async function applyUserChanges(
  event: APIGatewayProxyEvent,
  usersTable: string,
  userId: string,
  changes: ProfileChanges,
): Promise<APIGatewayProxyResult> {
  /**
   * Load the Profile and Cognito Account
   */
  const profileResult = await dynamodb.send(
    new GetCommand({
      TableName: usersTable,
      Key: { userId },
      ConsistentRead: true,
    }),
  );
  const profile = profileResult.Item;
  if (!profile) {
    return jsonResponse(event, 404, { message: "User not found" });
  }

  const cognitoUser = await findCognitoUser(
    userId,
    profile.userPoolType as UserPoolType | undefined,
  );
  if (!cognitoUser?.user.Username) {
    return jsonResponse(event, 409, {
      message: "Cognito account not found for this profile",
    });
  }

  const userPoolId = poolId(cognitoUser.type);
  const username = cognitoUser.user.Username;
  const status = changes.profile.status as UserStatus | undefined;

  /**
   * Push Changes to Cognito
   *
   * Attributes and enabled state are updated before DynamoDB so a Cognito
   * failure leaves the profile untouched.
   */
  if (changes.cognitoAttributes.length > 0) {
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: changes.cognitoAttributes,
      }),
    );
  }
  if (status === "DISABLED") {
    await cognito.send(
      new AdminDisableUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }),
    );
  } else if (status === "ACTIVE") {
    await cognito.send(
      new AdminEnableUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }),
    );
  }

  /**
   * Write the Profile Updates
   *
   * The pool type is always re-stamped from the Cognito lookup so older
   * profiles without it get backfilled.
   */
  const updated = await dynamodb.send(
    new UpdateCommand({
      TableName: usersTable,
      Key: { userId },
      ...buildUpdateExpression({
        ...changes.profile,
        userPoolType: cognitoUser.type,
      }),
      ConditionExpression: "attribute_exists(userId)",
      ReturnValues: "ALL_NEW",
    }),
  );
  return jsonResponse(event, 200, { user: updated.Attributes });
}
