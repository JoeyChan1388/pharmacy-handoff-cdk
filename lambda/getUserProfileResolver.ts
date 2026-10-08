import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface CognitoAuthorizerClaims {
  claims?: {
    sub?: string;
  };
}

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