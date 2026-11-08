import { jsonResponse } from "../shared/http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { dynamodb, queryAll } from "../shared/dynamodb";
import { authorizePlatformAdmin } from "../shared/authorization";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type {
  OrganizationMembership,
  StaffLocationAssignment,
} from "../shared/types";

/**
 * Config
 *
 * Table names the resolver reads from the environment.
 */
interface Config {
  usersTable: string;
  locationsTable: string;
  assignmentsTable: string;
  membershipsTable: string;
}

/**
 * Reads the required table names from the environment, throwing when any
 * value is missing so the deployment error surfaces immediately.
 *
 * @returns The resolved configuration
 */
function loadConfig(): Config {
  const config = {
    usersTable: process.env.USERS_TABLE_NAME,
    locationsTable: process.env.LOCATIONS_TABLE_NAME,
    assignmentsTable: process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME,
    membershipsTable: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error(
      "Platform location details Lambda is missing table configuration",
    );
  }
  return config as Config;
}

/**
 * GetPlatformLocationDetailsResolver Handler
 *
 * Handles GET /platform/organizations/{organizationId}/locations/{locationId}.
 * Returns the location record and the users assigned to it, whatever the
 * location's status. Platform admins only.
 *
 * @param event The API Gateway event
 * @returns A 200 response with the location and its assigned users; 403 for
 * non-admins; or 404 when the location does not exist in the organization.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const authorizationError = authorizePlatformAdmin(event);
  if (authorizationError) return authorizationError;

  const organizationId = event.pathParameters?.organizationId;
  const locationId = event.pathParameters?.locationId;
  if (!organizationId || !locationId) {
    return jsonResponse(event, 400, {
      message: "organizationId and locationId are required",
    });
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(event, 405, { message: "Method not allowed" });
  }

  const config = loadConfig();

  const [location, assignments] = await Promise.all([
    dynamodb.send(
      new GetCommand({
        TableName: config.locationsTable,
        Key: { organizationId, locationId },
        ConsistentRead: true,
      }),
    ),
    queryAll<StaffLocationAssignment & { userId: string }>({
      TableName: config.assignmentsTable,
      IndexName: "ByLocation",
      KeyConditionExpression: "locationId = :locationId",
      ExpressionAttributeValues: { ":locationId": locationId },
    }),
  ]);
  if (!location.Item) {
    return jsonResponse(event, 404, { message: "Location not found" });
  }

  /**
   * Resolve Assigned Users
   *
   * Assignments are keyed by location only, so keep those for this
   * organization, then attach each user's profile and organization role.
   */
  const assignedUsers = await Promise.all(
    assignments
      .filter((assignment) => assignment.organizationId === organizationId)
      .map(async ({ userId, status }) => {
        const [profile, membership] = await Promise.all([
          dynamodb.send(
            new GetCommand({ TableName: config.usersTable, Key: { userId } }),
          ),
          dynamodb.send(
            new GetCommand({
              TableName: config.membershipsTable,
              Key: { organizationId, userId },
            }),
          ),
        ]);
        const role = (membership.Item as OrganizationMembership | undefined)
          ?.role;
        return {
          userId,
          role,
          status,
          email: profile.Item?.email,
          givenName: profile.Item?.givenName,
          familyName: profile.Item?.familyName,
        };
      }),
  );

  return jsonResponse(event, 200, {
    location: location.Item,
    assignedUsers,
  });
};
