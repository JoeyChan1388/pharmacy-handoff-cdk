import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type {
  CognitoAuthorizerClaims,
  CreateOrganizationLocationRequest,
} from "../shared/types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Allowed Origins
 */
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
);

/**
 * Creates a response object for the API Gateway
 *
 * @param event The API Gateway event
 * @param statusCode The HTTP status code
 * @param body The response body
 * @returns The API Gateway response object
 */
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

/**
 * Validates an optional text field from the request body. If the value is
 * undefined, null, or an empty string, it returns undefined. If the value is a
 * string that exceeds the specified maxLength, it throws an error. Otherwise,
 * it returns the trimmed string.
 *
 * @param value The value to validate
 * @param field The name of the field (used in error messages)
 * @param maxLength The maximum allowed length for the string
 * @returns The validated string or undefined
 */
function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new Error(
      `${field} must be a string no longer than ${maxLength} characters`,
    );
  }
  return value.trim();
}

/**
 * CreateOrganizationLocationResolver Handler
 *
 * This Lambda function is responsible for creating a new location for an
 * organization. It requires the user to be a platform admin or an admin of
 * the organization, and it creates a new location in the locations table.
 *
 * @param event The API Gateway event containing the request details
 * and authorizer claims.
 * @returns An APIGatewayProxyResult containing the created location details
 * or an error message.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const claims = event.requestContext.authorizer as
    | CognitoAuthorizerClaims
    | undefined;
  const callerUserId = claims?.claims?.sub;
  const organizationId = event.pathParameters?.organizationId;

  if (!callerUserId) return response(event, 401, { message: "Unauthorized" });
  if (!organizationId) {
    return response(event, 400, { message: "organizationId is required" });
  }

  const membershipsTable = process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME;
  const organizationsTable = process.env.ORGANIZATIONS_TABLE_NAME;
  const locationsTable = process.env.LOCATIONS_TABLE_NAME;
  if (!membershipsTable || !organizationsTable || !locationsTable) {
    throw new Error("Create location Lambda is missing table configuration");
  }

  const membershipResult = await dynamodb.send(
    new GetCommand({
      TableName: membershipsTable,
      Key: { organizationId, userId: callerUserId },
      ConsistentRead: true,
    }),
  );
  if (
    membershipResult.Item?.role !== "ADMIN" ||
    membershipResult.Item.status !== "ACTIVE"
  ) {
    return response(event, 403, {
      message: "Organization admin access required",
    });
  }

  const organizationResult = await dynamodb.send(
    new GetCommand({
      TableName: organizationsTable,
      Key: { organizationId },
      ConsistentRead: true,
    }),
  );
  if (!organizationResult.Item) {
    return response(event, 404, { message: "Organization not found" });
  }
  if (organizationResult.Item.status === "INACTIVE") {
    return response(event, 409, { message: "Organization is inactive" });
  }

  let body: CreateOrganizationLocationRequest;
  try {
    body = JSON.parse(event.body ?? "") as CreateOrganizationLocationRequest;
  } catch {
    return response(event, 400, { message: "Request body must be valid JSON" });
  }

  let name: string | undefined;
  let addressLine1: string | undefined;
  let addressLine2: string | undefined;
  let city: string | undefined;
  let province: string | undefined;
  let postalCode: string | undefined;
  let phone: string | undefined;
  try {
    name = optionalText(body.name, "name", 120);
    addressLine1 = optionalText(body.addressLine1, "addressLine1", 160);
    addressLine2 = optionalText(body.addressLine2, "addressLine2", 160);
    city = optionalText(body.city, "city", 100);
    province = optionalText(body.province, "province", 100);
    postalCode = optionalText(body.postalCode, "postalCode", 20);
    phone = optionalText(body.phone, "phone", 32);
  } catch (error) {
    return response(event, 400, {
      message: (error as Error).message,
    });
  }

  if (!name || !city || !province) {
    return response(event, 400, {
      message: "name, city, and province are required",
    });
  }

  const locationId = randomUUID();
  const now = new Date().toISOString();
  const location = {
    organizationId,
    locationId,
    name,
    ...(addressLine1 ? { addressLine1 } : {}),
    ...(addressLine2 ? { addressLine2 } : {}),
    city,
    province,
    ...(postalCode ? { postalCode } : {}),
    ...(phone ? { phone } : {}),
    createdAt: now,
    updatedAt: now,
  };

  await dynamodb.send(
    new PutCommand({
      TableName: locationsTable,
      Item: location,
      ConditionExpression:
        "attribute_not_exists(organizationId) AND attribute_not_exists(locationId)",
    }),
  );

  return response(event, 201, { location });
};
