import { authorizePlatformAdmin } from "../shared/authorization";
import { scanAll } from "../shared/dynamodb";
import { jsonResponse } from "../shared/http";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const authorizationError = authorizePlatformAdmin(event);
  if (authorizationError) return authorizationError;

  const tableName = process.env.USERS_TABLE_NAME;
  if (!tableName) throw new Error("USERS_TABLE_NAME is required");

  const users = await scanAll<Record<string, unknown>>(tableName);
  return jsonResponse(event, 200, { users });
};
