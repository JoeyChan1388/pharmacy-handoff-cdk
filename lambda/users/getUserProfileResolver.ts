import { dynamodb } from "../shared/dynamodb";
import { jsonResponse } from "../shared/http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getCallerUserId } from "../shared/authorization";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * GetUserProfileResolver Handler
 *
 * Triggered by an API Gateway GET request to retrieve a user profile from the
 * DynamoDB Users table. The user must be authenticated via Cognito, and their
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
   * Retrieve the user profile from the DynamoDB Users table using the user ID.
   * If the profile is not found, return a 404 response.
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
