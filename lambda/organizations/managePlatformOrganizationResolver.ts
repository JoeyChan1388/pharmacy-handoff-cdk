import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

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
  const organizationId = event.pathParameters?.organizationId;

  if (!callerUserId) return response(event, 401, { message: "Unauthorized" });
  if (!platformAdminUserIds.has(callerUserId)) {
    return response(event, 403, { message: "Platform admin access required" });
  }
  if (!organizationId) {
    return response(event, 400, { message: "organizationId is required" });
  }

  const tableName = process.env.ORGANIZATIONS_TABLE_NAME;
  if (!tableName) throw new Error("ORGANIZATIONS_TABLE_NAME is required");

  if (event.httpMethod === "GET") {
    const result = await dynamodb.send(
      new GetCommand({
        TableName: tableName,
        Key: { organizationId },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) {
      return response(event, 404, { message: "Organization not found" });
    }
    return response(event, 200, { organization: result.Item });
  }

  let updates: { name?: string; status?: "ACTIVE" | "INACTIVE" } = {};
  if (event.httpMethod === "PATCH") {
    let body: { name?: unknown; status?: unknown };
    try {
      body = JSON.parse(event.body ?? "") as typeof body;
    } catch {
      return response(event, 400, { message: "Request body must be valid JSON" });
    }

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) {
        return response(event, 400, {
          message: "name must contain between 1 and 120 characters",
        });
      }
      updates.name = body.name.trim();
    }
    if (body.status !== undefined) {
      if (body.status !== "ACTIVE" && body.status !== "INACTIVE") {
        return response(event, 400, {
          message: "status must be ACTIVE or INACTIVE",
        });
      }
      updates.status = body.status;
    }
    if (Object.keys(updates).length === 0) {
      return response(event, 400, {
        message: "At least one of name or status is required",
      });
    }
  } else if (event.httpMethod === "DELETE") {
    updates.status = "INACTIVE";
  } else {
    return response(event, 405, { message: "Method not allowed" });
  }

  const expressionNames: Record<string, string> = {
    "#updatedAt": "updatedAt",
  };
  const expressionValues: Record<string, string> = {
    ":updatedAt": new Date().toISOString(),
  };
  const updatesExpression = ["#updatedAt = :updatedAt"];
  for (const [field, value] of Object.entries(updates)) {
    expressionNames[`#${field}`] = field;
    expressionValues[`:${field}`] = value;
    updatesExpression.push(`#${field} = :${field}`);
  }

  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { organizationId },
      UpdateExpression: `SET ${updatesExpression.join(", ")}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
      ConditionExpression: "attribute_exists(organizationId)",
      ReturnValues: "ALL_NEW",
    }),
  );
  return response(event, 200, { organization: result.Attributes });
};