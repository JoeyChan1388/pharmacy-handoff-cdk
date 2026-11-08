import { jsonResponse } from "../shared/http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { dynamodb, queryAll } from "../shared/dynamodb";
import { authorizePlatformAdmin } from "../shared/authorization";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type {
  OrganizationLocation,
  OrganizationMembership,
  StaffLocationAssignment,
  StaffOrganizationLocation,
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
  organizationsTable: string;
}

/**
 * UserOrganizationSummary
 *
 * One of a user's organizations as seen by a platform admin, including
 * inactive organizations and memberships that have not been accepted yet.
 */
interface UserOrganizationSummary {
  name?: string;
  organizationId: string;
  membershipStatus?: string;
  organizationStatus?: string;
  role: OrganizationMembership["role"];
  locations: StaffOrganizationLocation[];
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
    organizationsTable: process.env.ORGANIZATIONS_TABLE_NAME,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error(
      "Platform user organizations Lambda is missing table configuration",
    );
  }
  return config as Config;
}

/**
 * GetPlatformUserOrganizationsResolver Handler
 *
 * Handles GET /platform/users/{userId}/organizations. Returns every
 * organization the user belongs to, with their role, the membership and
 * organization status, and the locations they are assigned to. Unlike
 * GET /staff/me/organizations, nothing is filtered by status.
 *
 * @param event The API Gateway event
 * @returns A 200 response with the user's organizations; 403 for non-admins;
 * or 404 when the user does not exist.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const authorizationError = authorizePlatformAdmin(event);
  if (authorizationError) return authorizationError;

  const userId = event.pathParameters?.userId;
  if (!userId) {
    return jsonResponse(event, 400, { message: "userId is required" });
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(event, 405, { message: "Method not allowed" });
  }

  const config = loadConfig();

  const [profile, memberships, assignments] = await Promise.all([
    dynamodb.send(
      new GetCommand({ TableName: config.usersTable, Key: { userId } }),
    ),
    queryAll<OrganizationMembership>({
      TableName: config.membershipsTable,
      IndexName: "ByUser",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId },
    }),
    queryAll<StaffLocationAssignment>({
      TableName: config.assignmentsTable,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId },
    }),
  ]);
  if (!profile.Item) {
    return jsonResponse(event, 404, { message: "User not found" });
  }

  const activeAssignments = assignments.filter(
    (assignment) => assignment.status === "ACTIVE",
  );

  const organizations = await Promise.all(
    memberships.map(async (membership): Promise<UserOrganizationSummary> => {
      const { organizationId } = membership;
      const [organization, locationResults] = await Promise.all([
        dynamodb.send(
          new GetCommand({
            TableName: config.organizationsTable,
            Key: { organizationId },
          }),
        ),
        Promise.all(
          activeAssignments
            .filter(
              (assignment) => assignment.organizationId === organizationId,
            )
            .map((assignment) =>
              dynamodb.send(
                new GetCommand({
                  TableName: config.locationsTable,
                  Key: { organizationId, locationId: assignment.locationId },
                }),
              ),
            ),
        ),
      ]);

      return {
        organizationId,
        name: organization.Item?.name,
        organizationStatus: organization.Item?.status,
        role: membership.role,
        membershipStatus: membership.status,
        locations: locationResults
          .map((result) => result.Item as OrganizationLocation | undefined)
          .filter(
            (location): location is OrganizationLocation =>
              location !== undefined,
          )
          .map(({ locationId, name, city, province, status }) => ({
            locationId,
            name,
            city,
            province,
            status,
          })),
      };
    }),
  );

  return jsonResponse(event, 200, { organizations });
};
