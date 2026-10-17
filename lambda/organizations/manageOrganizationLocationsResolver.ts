import { randomUUID } from "node:crypto";
import { parseJsonBody } from "../shared/validation";
import { dynamodb, queryAll } from "../shared/dynamodb";
import { getCallerUserId } from "../shared/authorization";
import { jsonResponse as response } from "../shared/http";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import type { CreateOrganizationLocationRequest } from "../shared/types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

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
  const callerUserId = getCallerUserId(event);
  const organizationId = event.pathParameters?.organizationId;

  if (!callerUserId) return response(event, 401, { message: "Unauthorized" });
  if (!organizationId) {
    return response(event, 400, { message: "organizationId is required" });
  }

  const membershipsTable = process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME;
  const organizationsTable = process.env.ORGANIZATIONS_TABLE_NAME;
  const locationsTable = process.env.LOCATIONS_TABLE_NAME;
  const locationId = event.pathParameters?.locationId;
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

  if (event.httpMethod === "GET") {
    if (locationId) {
      const result = await dynamodb.send(
        new GetCommand({
          TableName: locationsTable,
          Key: { organizationId, locationId },
          ConsistentRead: true,
        }),
      );
      if (!result.Item) {
        return response(event, 404, { message: "Location not found" });
      }
      return response(event, 200, { location: result.Item });
    }

    const locations = await queryAll<Record<string, unknown>>({
      TableName: locationsTable,
      KeyConditionExpression: "organizationId = :organizationId",
      ExpressionAttributeValues: { ":organizationId": organizationId },
    });
    return response(event, 200, { locations });
  }

  if (event.httpMethod === "DELETE") {
    if (!locationId) {
      return response(event, 400, { message: "locationId is required" });
    }
    let result;
    try {
      result = await dynamodb.send(
        new UpdateCommand({
          TableName: locationsTable,
          Key: { organizationId, locationId },
          UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt",
          ExpressionAttributeNames: {
            "#status": "status",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":status": "INACTIVE",
            ":updatedAt": new Date().toISOString(),
          },
          ConditionExpression: "attribute_exists(locationId)",
          ReturnValues: "ALL_NEW",
        }),
      );
    } catch (error) {
      if (
        (error as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return response(event, 404, { message: "Location not found" });
      }
      throw error;
    }
    return response(event, 200, { location: result.Attributes });
  }

  if (event.httpMethod === "PATCH") {
    if (!locationId) {
      return response(event, 400, { message: "locationId is required" });
    }
    const body = parseJsonBody<
      Partial<CreateOrganizationLocationRequest> & {
        status?: unknown;
      }
    >(event);
    if (!body) {
      return response(event, 400, {
        message: "Request body must be valid JSON",
      });
    }

    const allowedFields = [
      "name",
      "addressLine1",
      "addressLine2",
      "city",
      "province",
      "postalCode",
      "phone",
    ] as const;
    const updates: Record<string, string> = {};
    try {
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          const maxLength =
            field === "name"
              ? 120
              : field === "city" || field === "province"
                ? 100
                : field === "postalCode"
                  ? 20
                  : field === "phone"
                    ? 32
                    : 160;
          const value = optionalText(body[field], field, maxLength);
          if (!value) {
            return response(event, 400, {
              message: `${field} cannot be empty; omit it to leave it unchanged`,
            });
          }
          updates[field] = value;
        }
      }
    } catch (error) {
      return response(event, 400, { message: (error as Error).message });
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
        message: "At least one location field or status is required",
      });
    }

    const expressionNames: Record<string, string> = {
      "#updatedAt": "updatedAt",
    };
    const expressionValues: Record<string, string> = {
      ":updatedAt": new Date().toISOString(),
    };
    const expressions = ["#updatedAt = :updatedAt"];
    for (const [field, value] of Object.entries(updates)) {
      expressionNames[`#${field}`] = field;
      expressionValues[`:${field}`] = value;
      expressions.push(`#${field} = :${field}`);
    }

    let result;
    try {
      result = await dynamodb.send(
        new UpdateCommand({
          TableName: locationsTable,
          Key: { organizationId, locationId },
          UpdateExpression: `SET ${expressions.join(", ")}`,
          ExpressionAttributeNames: expressionNames,
          ExpressionAttributeValues: expressionValues,
          ConditionExpression: "attribute_exists(locationId)",
          ReturnValues: "ALL_NEW",
        }),
      );
    } catch (error) {
      if (
        (error as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return response(event, 404, { message: "Location not found" });
      }
      throw error;
    }
    return response(event, 200, { location: result.Attributes });
  }

  if (event.httpMethod !== "POST") {
    return response(event, 405, { message: "Method not allowed" });
  }

  const body = parseJsonBody<CreateOrganizationLocationRequest>(event);
  if (!body) {
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

  const newLocationId = randomUUID();
  const now = new Date().toISOString();
  const location = {
    organizationId,
    locationId: newLocationId,
    name,
    ...(addressLine1 ? { addressLine1 } : {}),
    ...(addressLine2 ? { addressLine2 } : {}),
    city,
    province,
    status: "ACTIVE",
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
