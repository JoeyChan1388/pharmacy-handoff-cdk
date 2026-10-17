import { randomUUID } from "node:crypto";
import { jsonResponse } from "../shared/http";
import { getCallerUserId } from "../shared/authorization";
import { optionalText, parseJsonBody } from "../shared/validation";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isAccessError, loadOrganizationAccess } from "../shared/organizations";
import {
  buildUpdateExpression,
  dynamodb,
  isConditionalCheckFailed,
  queryAll,
} from "../shared/dynamodb";

import type { CreateOrganizationLocationRequest } from "../shared/types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * Location Field Limits
 *
 * Maximum trimmed length for each editable text field on a location.
 */
const LOCATION_FIELD_LIMITS = {
  name: 120,
  city: 100,
  phone: 32,
  province: 100,
  postalCode: 20,
  addressLine1: 160,
  addressLine2: 160,
} as const;

type LocationField = keyof typeof LOCATION_FIELD_LIMITS;

/**
 * Config
 *
 * Table names the resolver reads from the environment.
 */
interface Config {
  locationsTable: string;
  membershipsTable: string;
  organizationsTable: string;
}

/**
 * LocationKey
 *
 * The composite primary key of a location item.
 */
interface LocationKey {
  locationId: string;
  organizationId: string;
}

/**
 * Reads the required table names from the environment, throwing when any
 * value is missing so the deployment error surfaces immediately.
 *
 * @returns The resolved configuration
 */
function loadConfig(): Config {
  const config = {
    locationsTable: process.env.LOCATIONS_TABLE_NAME,
    membershipsTable: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
    organizationsTable: process.env.ORGANIZATIONS_TABLE_NAME,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error("Manage locations Lambda is missing table configuration");
  }
  return config as Config;
}

/**
 * Validates every location text field present in a request body against its
 * length limit, returning the trimmed values keyed by field.
 *
 * @param body The parsed request body
 * @returns The validated fields, or an error message to return as a 400
 */
function validateLocationFields(
  body: Partial<CreateOrganizationLocationRequest>,
): Partial<Record<LocationField, string>> | string {
  const fields: Partial<Record<LocationField, string>> = {};
  try {
    for (const field of Object.keys(LOCATION_FIELD_LIMITS) as LocationField[]) {
      const value = optionalText(
        body[field],
        field,
        LOCATION_FIELD_LIMITS[field],
      );
      if (value !== undefined) fields[field] = value;
    }
  } catch (error) {
    return (error as Error).message;
  }
  return fields;
}

/**
 * ManageOrganizationLocationsResolver Handler
 *
 * Single Lambda for the organization locations resource. Every route requires
 * an active ADMIN membership in the organization:
 *
 * - GET    /organizations/{organizationId}/locations               list
 * - POST   /organizations/{organizationId}/locations               create
 * - GET    /organizations/{organizationId}/locations/{locationId}  retrieve
 * - PATCH  /organizations/{organizationId}/locations/{locationId}  update
 * - DELETE /organizations/{organizationId}/locations/{locationId}  soft-delete
 *
 * @param event The API Gateway event containing the request details
 * and authorizer claims.
 * @returns An APIGatewayProxyResult for the requested operation.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const callerUserId = getCallerUserId(event);
  const organizationId = event.pathParameters?.organizationId;
  const locationId = event.pathParameters?.locationId;

  if (!callerUserId) {
    return jsonResponse(event, 401, { message: "Unauthorized" });
  }
  if (!organizationId) {
    return jsonResponse(event, 400, { message: "organizationId is required" });
  }

  const config = loadConfig();

  /**
   * Organization Access Check
   *
   * The caller must be an active admin and the organization must be active.
   */
  const access = await loadOrganizationAccess(
    event,
    callerUserId,
    organizationId,
    {
      organizationsTable: config.organizationsTable,
      membershipsTable: config.membershipsTable,
      allowedRoles: ["ADMIN"],
    },
  );
  if (isAccessError(access)) return access;

  /**
   * Route Dispatch
   *
   * Collection routes have no locationId in the path; item routes do.
   */
  if (!locationId) {
    switch (event.httpMethod) {
      case "GET":
        return listLocations(event, config, organizationId);
      case "POST":
        return createLocation(event, config, organizationId);
      default:
        return jsonResponse(event, 405, { message: "Method not allowed" });
    }
  }

  const key: LocationKey = { organizationId, locationId };
  switch (event.httpMethod) {
    case "GET":
      return getLocation(event, config, key);
    case "PATCH":
      return updateLocation(event, config, key);
    case "DELETE":
      return deleteLocation(event, config, key);
    default:
      return jsonResponse(event, 405, { message: "Method not allowed" });
  }
};

/**
 * List Locations
 *
 * Returns every location belonging to the organization, including inactive
 * ones so admins can reactivate them.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param organizationId The organization to list locations for
 * @returns A 200 response with the locations array
 */
async function listLocations(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  const locations = await queryAll<Record<string, unknown>>({
    TableName: config.locationsTable,
    KeyConditionExpression: "organizationId = :organizationId",
    ExpressionAttributeValues: { ":organizationId": organizationId },
  });
  return jsonResponse(event, 200, { locations });
}

/**
 * Get Location
 *
 * Returns a single location by key.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param key The location's primary key
 * @returns A 200 response with the location, or 404 if missing
 */
async function getLocation(
  event: APIGatewayProxyEvent,
  config: Config,
  key: LocationKey,
): Promise<APIGatewayProxyResult> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: config.locationsTable,
      Key: key,
      ConsistentRead: true,
    }),
  );
  if (!result.Item) {
    return jsonResponse(event, 404, { message: "Location not found" });
  }
  return jsonResponse(event, 200, { location: result.Item });
}

/**
 * Create Location
 *
 * Validates the request body and writes a new ACTIVE location. Name, city,
 * and province are required; the remaining address fields are optional.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param organizationId The organization that owns the new location
 * @returns A 201 response with the new location, or a 400 error
 */
async function createLocation(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<CreateOrganizationLocationRequest>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const fields = validateLocationFields(body);
  if (typeof fields === "string") {
    return jsonResponse(event, 400, { message: fields });
  }
  if (!fields.name || !fields.city || !fields.province) {
    return jsonResponse(event, 400, {
      message: "name, city, and province are required",
    });
  }

  const now = new Date().toISOString();
  const location = {
    organizationId,
    locationId: randomUUID(),
    ...fields,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };

  await dynamodb.send(
    new PutCommand({
      TableName: config.locationsTable,
      Item: location,
      ConditionExpression:
        "attribute_not_exists(organizationId) AND attribute_not_exists(locationId)",
    }),
  );

  return jsonResponse(event, 201, { location });
}

/**
 * Update Location
 *
 * Validates the request body and applies any provided address fields and/or
 * status. A field that is present but empty is rejected rather than cleared.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param key The location's primary key
 * @returns A 200 response with the updated location, or a 4xx error
 */
async function updateLocation(
  event: APIGatewayProxyEvent,
  config: Config,
  key: LocationKey,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<
    Partial<CreateOrganizationLocationRequest> & { status?: unknown }
  >(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const fields = validateLocationFields(body);
  if (typeof fields === "string") {
    return jsonResponse(event, 400, { message: fields });
  }

  // A key that is present but blank would otherwise silently drop the field.
  const blankField = (
    Object.keys(LOCATION_FIELD_LIMITS) as LocationField[]
  ).find((field) => body[field] !== undefined && fields[field] === undefined);
  if (blankField) {
    return jsonResponse(event, 400, {
      message: `${blankField} cannot be empty; omit it to leave it unchanged`,
    });
  }

  const updates: Record<string, string> = { ...fields };
  if (body.status !== undefined) {
    if (body.status !== "ACTIVE" && body.status !== "INACTIVE") {
      return jsonResponse(event, 400, {
        message: "status must be ACTIVE or INACTIVE",
      });
    }
    updates.status = body.status;
  }
  if (Object.keys(updates).length === 0) {
    return jsonResponse(event, 400, {
      message: "At least one location field or status is required",
    });
  }

  return applyLocationUpdates(event, config, key, updates);
}

/**
 * Delete Location
 *
 * Soft-deletes a location by marking it INACTIVE.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param key The location's primary key
 * @returns A 200 response with the updated location, or 404 if missing
 */
async function deleteLocation(
  event: APIGatewayProxyEvent,
  config: Config,
  key: LocationKey,
): Promise<APIGatewayProxyResult> {
  return applyLocationUpdates(event, config, key, { status: "INACTIVE" });
}

/**
 * Apply Location Updates
 *
 * Writes a set of field changes to an existing location and returns the new
 * item. A failed condition check means the location does not exist.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param key The location's primary key
 * @param updates The fields to set
 * @returns A 200 response with the updated location, or 404 if missing
 */
async function applyLocationUpdates(
  event: APIGatewayProxyEvent,
  config: Config,
  key: LocationKey,
  updates: Record<string, string>,
): Promise<APIGatewayProxyResult> {
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: config.locationsTable,
        Key: key,
        ...buildUpdateExpression(updates),
        ConditionExpression: "attribute_exists(locationId)",
        ReturnValues: "ALL_NEW",
      }),
    );
    return jsonResponse(event, 200, { location: result.Attributes });
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return jsonResponse(event, 404, { message: "Location not found" });
    }
    throw error;
  }
}
