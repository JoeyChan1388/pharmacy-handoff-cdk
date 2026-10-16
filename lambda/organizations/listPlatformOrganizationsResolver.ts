import { scanAll } from "../shared/dynamodb";
import { jsonResponse } from "../shared/http";
import { authorizePlatformAdmin } from "../shared/authorization";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const response = jsonResponse;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const authorizationError = authorizePlatformAdmin(event);
  if (authorizationError) return authorizationError;

  const tableName = process.env.ORGANIZATIONS_TABLE_NAME;
  if (!tableName) throw new Error("ORGANIZATIONS_TABLE_NAME is required");

  const organizations = await scanAll<Record<string, unknown>>(tableName);

  return response(event, 200, { organizations });
};