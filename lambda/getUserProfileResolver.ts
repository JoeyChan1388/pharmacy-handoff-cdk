import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
  const authorizer = event.requestContext.authorizer as
    | CognitoAuthorizerClaims
    | undefined;
  const userId = authorizer?.claims?.sub;

  if (!userId) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Unauthorized" }),
    };
  }

  const tableName = process.env.USERS_TABLE_NAME;
  if (!tableName) {
    throw new Error("USERS_TABLE_NAME environment variable is required");
  }

  const result = await dynamodb.send(
    new GetCommand({
      TableName: tableName,
      Key: { userId },
    }),
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Profile not found" }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result.Item),
  };
};
