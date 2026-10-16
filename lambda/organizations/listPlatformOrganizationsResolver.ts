import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

import type { CognitoAuthorizerClaims } from "../shared/types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

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

  const tableName = process.env.ORGANIZATIONS_TABLE_NAME;
  if (!tableName) throw new Error("ORGANIZATIONS_TABLE_NAME is required");

  const organizations: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    organizations.push(...((result.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return response(event, 200, { organizations });
};