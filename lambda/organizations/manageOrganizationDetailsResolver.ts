import { jsonResponse } from "../shared/http";
import { getCallerUserId } from "../shared/authorization";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { parseJsonBody, requiredText } from "../shared/validation";
import { buildUpdateExpression, dynamodb, queryAll } from "../shared/dynamodb";
import {
  isAccessError,
  loadOrganizationAccess,
  type OrganizationRecord,
} from "../shared/organizations";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type {
  OrganizationLocation,
  OrganizationMembership,
  StaffLocationAssignment,
} from "../shared/types";

/**
 * Maximum length of an organization name.
 */
const NAME_MAX_LENGTH = 120;

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
 * OrganizationUser
 *
 * A member of the organization as returned by the details endpoint, combining
 * the membership record, the user profile, and active location assignments.
 */
interface OrganizationUser {
  userId: string;
  email?: string;
  status?: string;
  givenName?: string;
  familyName?: string;
  userStatus?: string;
  locationIds: string[];
  role: OrganizationMembership["role"];
}

/**
 * OrganizationLocationDetails
 *
 * A location enriched with the members currently assigned to it.
 */
interface OrganizationLocationDetails extends OrganizationLocation {
  assignedUsers: Pick<
    OrganizationUser,
    "userId" | "email" | "role" | "status"
  >[];
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
      "Organization details Lambda is missing table configuration",
    );
  }
  return config as Config;
}

/**
 * Loads a member's profile and their active location IDs within the
 * organization.
 *
 * @param config The resolved environment configuration
 * @param membership The member's organization membership
 * @param organizationId The organization being described
 * @returns The member with profile fields and active location IDs
 */
async function loadOrganizationUser(
  config: Config,
  membership: OrganizationMembership,
  organizationId: string,
): Promise<OrganizationUser> {
  const [profileResult, assignments] = await Promise.all([
    dynamodb.send(
      new GetCommand({
        TableName: config.usersTable,
        Key: { userId: membership.userId },
      }),
    ),
    queryAll<StaffLocationAssignment>({
      TableName: config.assignmentsTable,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": membership.userId },
    }),
  ]);
  const profile = profileResult.Item;

  return {
    userId: membership.userId,
    email: profile?.email ?? membership.email,
    givenName: profile?.givenName,
    familyName: profile?.familyName,
    role: membership.role,
    status: membership.status,
    userStatus: profile?.status,
    locationIds: assignments
      .filter(
        (assignment) =>
          assignment.organizationId === organizationId &&
          assignment.status === "ACTIVE",
      )
      .map((assignment) => assignment.locationId),
  };
}

/**
 * ManageOrganizationDetailsResolver Handler
 *
 * Single Lambda for the organization details resource, used by organization
 * members rather than platform admins:
 *
 * - GET    /organizations/{organizationId}/details  roster and locations,
 *          scoped to the caller's role
 * - PATCH  /organizations/{organizationId}/details  update the organization
 *          name; requires an active ADMIN membership
 * - DELETE /organizations/{organizationId}/details  soft-delete by marking
 *          the organization INACTIVE; requires an active ADMIN membership
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
   * Any active member may read; the organization must be active.
   */
  const access = await loadOrganizationAccess(
    event,
    callerUserId,
    organizationId,
    {
      organizationsTable: config.organizationsTable,
      membershipsTable: config.membershipsTable,
      allowedRoles: ["ADMIN", "STAFF"],
    },
  );
  if (isAccessError(access)) return access;

  // Pin the key fields to the request so the stored item cannot drift them.
  const callerMembership: OrganizationMembership = {
    ...access.membership,
    userId: callerUserId,
    organizationId,
  };
  const isAdmin = callerMembership.role === "ADMIN";

  /**
   * Route Dispatch
   *
   * Writes are limited to organization admins.
   */
  switch (event.httpMethod) {
    case "GET":
      return getDetails(event, config, callerMembership, access.organization);
    case "PATCH":
    case "DELETE":
      if (!isAdmin) {
        return jsonResponse(event, 403, {
          message: "Organization admin access required",
        });
      }
      return event.httpMethod === "PATCH"
        ? updateOrganization(event, config, organizationId)
        : deleteOrganization(event, config, organizationId);
    default:
      return jsonResponse(event, 405, { message: "Method not allowed" });
  }
};

/**
 * Get Details
 *
 * Returns the organization, its members, and its locations. Admins receive
 * the full roster and every location. Staff receive only their own
 * membership and the active locations they are assigned to.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param callerMembership The caller's membership record
 * @param organization The organization record
 * @returns A 200 response with organization, users, and locations
 */
async function getDetails(
  event: APIGatewayProxyEvent,
  config: Config,
  callerMembership: OrganizationMembership,
  organization: OrganizationRecord,
): Promise<APIGatewayProxyResult> {
  const { organizationId } = callerMembership;
  let users: OrganizationUser[];
  let locations: OrganizationLocation[];

  if (callerMembership.role === "ADMIN") {
    /**
     * Admin View
     *
     * Load every membership and every location, then enrich each member
     * with their profile and assignments.
     */
    const [memberships, allLocations] = await Promise.all([
      queryAll<OrganizationMembership>({
        TableName: config.membershipsTable,
        KeyConditionExpression: "organizationId = :organizationId",
        ExpressionAttributeValues: { ":organizationId": organizationId },
      }),
      queryAll<OrganizationLocation>({
        TableName: config.locationsTable,
        KeyConditionExpression: "organizationId = :organizationId",
        ExpressionAttributeValues: { ":organizationId": organizationId },
      }),
    ]);
    locations = allLocations;
    users = await Promise.all(
      memberships.map((membership) =>
        loadOrganizationUser(config, membership, organizationId),
      ),
    );
  } else {
    /**
     * Staff View
     *
     * Load only the caller and the active locations they are assigned to.
     */
    const caller = await loadOrganizationUser(
      config,
      callerMembership,
      organizationId,
    );
    const locationResults = await Promise.all(
      caller.locationIds.map((locationId) =>
        dynamodb.send(
          new GetCommand({
            TableName: config.locationsTable,
            Key: { organizationId, locationId },
          }),
        ),
      ),
    );
    locations = locationResults
      .map((result) => result.Item as OrganizationLocation | undefined)
      .filter(
        (location): location is OrganizationLocation =>
          location !== undefined && location.status !== "INACTIVE",
      );
    caller.locationIds = locations.map((location) => location.locationId);
    users = [caller];
  }

  /**
   * Attach Assigned Users to Each Location
   */
  const locationsWithUsers: OrganizationLocationDetails[] = locations.map(
    (location) => ({
      ...location,
      assignedUsers: users
        .filter((user) => user.locationIds.includes(location.locationId))
        .map(({ userId, email, role, status }) => ({
          userId,
          email,
          role,
          status,
        })),
    }),
  );

  return jsonResponse(event, 200, {
    organization,
    users,
    locations: locationsWithUsers,
  });
}

/**
 * Update Organization
 *
 * Renames the organization. Status is deliberately excluded; only platform
 * admins can activate or deactivate an organization through this route's
 * platform counterpart.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param organizationId The organization to rename
 * @returns A 200 response with the updated organization, or a 400 error
 */
async function updateOrganization(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<{ name?: unknown }>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const name = requiredText(body.name, NAME_MAX_LENGTH);
  if (!name) {
    return jsonResponse(event, 400, {
      message: `name must contain between 1 and ${NAME_MAX_LENGTH} characters`,
    });
  }

  return applyOrganizationUpdates(event, config, organizationId, { name });
}

/**
 * Delete Organization
 *
 * Soft-deletes the organization by marking it INACTIVE. Memberships,
 * locations, and assignments are retained.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param organizationId The organization to deactivate
 * @returns A 200 response with the updated organization
 */
async function deleteOrganization(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  return applyOrganizationUpdates(event, config, organizationId, {
    status: "INACTIVE",
  });
}

/**
 * Apply Organization Updates
 *
 * Writes a set of field changes to the organization and returns the new item.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param organizationId The organization to update
 * @param updates The fields to set
 * @returns A 200 response with the updated organization
 */
async function applyOrganizationUpdates(
  event: APIGatewayProxyEvent,
  config: Config,
  organizationId: string,
  updates: Record<string, string>,
): Promise<APIGatewayProxyResult> {
  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: config.organizationsTable,
      Key: { organizationId },
      ...buildUpdateExpression(updates),
      ConditionExpression: "attribute_exists(organizationId)",
      ReturnValues: "ALL_NEW",
    }),
  );
  return jsonResponse(event, 200, { organization: result.Attributes });
}
