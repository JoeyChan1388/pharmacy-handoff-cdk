import { dynamodb } from "../shared/dynamodb";
import { jsonResponse } from "../shared/http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getCallerUserId } from "../shared/authorization";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * GetUserProfileResolver Handler
 *
 * Handles GET /staff/me and GET /patient/me. Returns the caller's own profile
 * from the users table. The caller is identified by the Cognito sub in the
 * authorizer claims, so no path parameters are needed.
 *
 * @param event Payload that contains the request context and authorizer
 * claims from API Gateway.
 * @returns An APIGatewayProxyResult containing the user profile data or an
 * error message.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  // Extract the user ID from the Cognito authorizer claims from the event.
  const userId = getCallerUserId(event);

  if (!userId) {
    return jsonResponse(event, 401, { message: "Unauthorized" });
  }

  const tableName = process.env.USERS_TABLE_NAME;
  if (!tableName) {
    throw new Error("USERS_TABLE_NAME environment variable is required");
  }

  /**
   * Load the Profile
   *
   * The profile is keyed by the Cognito sub, so a missing item means the
   * post-confirmation trigger has not run for this user yet.
   */
  const result = await dynamodb.send(
    new GetCommand({
      TableName: tableName,
      Key: { userId },
    }),
  );

  if (!result.Item) {
    return jsonResponse(event, 404, { message: "Profile not found" });
  }

  return jsonResponse(event, 200, result.Item as Record<string, unknown>);
};
