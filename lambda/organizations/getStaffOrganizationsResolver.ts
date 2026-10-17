import { jsonResponse } from "../shared/http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { dynamodb, queryAll } from "../shared/dynamodb";
import { getCallerUserId } from "../shared/authorization";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type {
  OrganizationLocation,
  OrganizationMembership,
  StaffLocationAssignment,
  StaffOrganizationSummary,
} from "../shared/types";

/**
 * Config
 *
 * Table names the resolver reads from the environment.
 */
interface Config {
  locationsTable: string;
  assignmentsTable: string;
  membershipsTable: string;
  organizationsTable: string;
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
    assignmentsTable: process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME,
    membershipsTable: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
    organizationsTable: process.env.ORGANIZATIONS_TABLE_NAME,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error(
      "Staff organizations Lambda is missing table configuration",
    );
  }
  return config as Config;
}

/**
 * Loads the locations a member can see in one organization. Admins see every
 * location; staff see only the active locations they are assigned to.
 *
 * @param config The resolved environment configuration
 * @param membership The member's organization membership
 * @param assignments The member's active assignments across all organizations
 * @returns The visible locations
 */
async function loadVisibleLocations(
  config: Config,
  membership: OrganizationMembership,
  assignments: StaffLocationAssignment[],
): Promise<OrganizationLocation[]> {
  const { organizationId } = membership;

  if (membership.role === "ADMIN") {
    return queryAll<OrganizationLocation>({
      TableName: config.locationsTable,
      KeyConditionExpression: "organizationId = :organizationId",
      ExpressionAttributeValues: { ":organizationId": organizationId },
    });
  }

  const results = await Promise.all(
    assignments
      .filter((assignment) => assignment.organizationId === organizationId)
      .map((assignment) =>
        dynamodb.send(
          new GetCommand({
            TableName: config.locationsTable,
            Key: { organizationId, locationId: assignment.locationId },
          }),
        ),
      ),
  );
  return results
    .map((result) => result.Item as OrganizationLocation | undefined)
    .filter(
      (location): location is OrganizationLocation =>
        location !== undefined && location.status !== "INACTIVE",
    );
}

/**
 * GetStaffOrganizationsResolver Handler
 *
 * Handles GET /staff/me/organizations. Returns every active organization the
 * caller belongs to, with their role and the locations visible to them.
 * Inactive organizations are omitted.
 *
 * @param event The API Gateway event containing the request context and
 * authorizer claims.
 * @returns A 200 response with the caller's organizations, or 401 if the
 * caller is not authenticated.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getCallerUserId(event);
  if (!userId) {
    return jsonResponse(event, 401, { message: "Unauthorized" });
  }

  const config = loadConfig();

  /**
   * Load Active Memberships and Assignments
   *
   * Both are keyed by the caller, so they can be fetched in parallel.
   */
  const [memberships, assignments] = await Promise.all([
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
  const activeMemberships = memberships.filter(
    (membership) => membership.status === "ACTIVE",
  );
  const activeAssignments = assignments.filter(
    (assignment) => assignment.status === "ACTIVE",
  );

  /**
   * Build One Summary per Organization
   *
   * Each membership resolves to its organization and visible locations, or
   * undefined when the organization has been deactivated.
   */
  const summaries = await Promise.all(
    activeMemberships.map(
      async (membership): Promise<StaffOrganizationSummary | undefined> => {
        const organizationResult = await dynamodb.send(
          new GetCommand({
            TableName: config.organizationsTable,
            Key: { organizationId: membership.organizationId },
          }),
        );
        if (organizationResult.Item?.status === "INACTIVE") return undefined;

        const locations = await loadVisibleLocations(
          config,
          membership,
          activeAssignments,
        );

        return {
          organizationId: membership.organizationId,
          name: organizationResult.Item?.name,
          role: membership.role,
          locations: locations.map(
            ({ locationId, name, city, province, status }) => ({
              locationId,
              name,
              city,
              province,
              status,
            }),
          ),
        };
      },
    ),
  );

  return jsonResponse(event, 200, {
    organizations: summaries.filter(
      (summary): summary is StaffOrganizationSummary => summary !== undefined,
    ),
  });
};
