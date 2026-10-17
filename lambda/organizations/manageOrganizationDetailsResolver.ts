import { jsonResponse } from "../shared/http";
import { parseJsonBody } from "../shared/validation";
import { dynamodb, queryAll } from "../shared/dynamodb";
import { getCallerUserId } from "../shared/authorization";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import type {
  OrganizationMembership,
  OrganizationLocation,
  StaffLocationAssignment,
} from "../shared/types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

interface OrganizationUser {
  userId: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  role: OrganizationMembership["role"];
  status?: string;
  userStatus?: string;
  locationIds: string[];
}

interface OrganizationLocationDetails extends OrganizationLocation {
  assignedUsers: Pick<OrganizationUser, "userId" | "email" | "role" | "status">[];
}

/**
 * ManageOrganizationDetailsResolver Handler
 *
 * Single Lambda for the organization details resource, used by organization
 * members (not platform admins):
 *
 * - GET   /organizations/{organizationId}/details  roster and locations,
 *         scoped to the caller's role
 * - PATCH /organizations/{organizationId}/details  update the organization
 *         name; requires an active ADMIN membership
 * - DELETE /organizations/{organizationId}/details soft-delete by marking
 *         the organization INACTIVE; requires an active ADMIN membership
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const callerUserId = getCallerUserId(event);
  if (!callerUserId) {
    return jsonResponse(event, 401, { message: "Unauthorized" });
  }

  const organizationId = event.pathParameters?.organizationId;
  if (!organizationId) {
    return jsonResponse(event, 400, {
      message: "organizationId is required",
    });
  }

  const tableNames = {
    organizations: process.env.ORGANIZATIONS_TABLE_NAME,
    memberships: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
    users: process.env.USERS_TABLE_NAME,
    locations: process.env.LOCATIONS_TABLE_NAME,
    assignments: process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME,
  };
  if (Object.values(tableNames).some((tableName) => !tableName)) {
    throw new Error("Organization details Lambda is missing table configuration");
  }

  const callerMembership = await dynamodb.send(
    new GetCommand({
      TableName: tableNames.memberships,
      Key: { organizationId, userId: callerUserId },
      ConsistentRead: true,
    }),
  );
  if (
    !callerMembership.Item ||
    callerMembership.Item.status !== "ACTIVE" ||
    !["ADMIN", "STAFF"].includes(callerMembership.Item.role)
  ) {
    return jsonResponse(event, 403, {
      message: "Active organization membership required",
    });
  }
  const isOrganizationAdmin = callerMembership.Item.role === "ADMIN";

  const organizationResult = await dynamodb.send(
    new GetCommand({
      TableName: tableNames.organizations,
      Key: { organizationId },
      ConsistentRead: true,
    }),
  );
  if (!organizationResult.Item) {
    return jsonResponse(event, 404, { message: "Organization not found" });
  }
  if (organizationResult.Item.status === "INACTIVE") {
    return jsonResponse(event, 409, { message: "Organization is inactive" });
  }

  if (event.httpMethod === "PATCH" || event.httpMethod === "DELETE") {
    if (!isOrganizationAdmin) {
      return jsonResponse(event, 403, {
        message: "Organization admin access required",
      });
    }
    if (event.httpMethod === "DELETE") {
      return applyUpdates(event, tableNames.organizations!, organizationId, {
        status: "INACTIVE",
      });
    }
    return handleUpdate(event, tableNames.organizations!, organizationId);
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(event, 405, { message: "Method not allowed" });
  }

  let usersWithAssignments: OrganizationUser[];
  let locations: OrganizationLocation[];

  if (isOrganizationAdmin) {
    const [memberships, allLocations] = await Promise.all([
      queryAll<OrganizationMembership>({
        TableName: tableNames.memberships,
        KeyConditionExpression: "organizationId = :organizationId",
        ExpressionAttributeValues: { ":organizationId": organizationId },
      }),
      queryAll<OrganizationLocation>({
        TableName: tableNames.locations,
        KeyConditionExpression: "organizationId = :organizationId",
        ExpressionAttributeValues: { ":organizationId": organizationId },
      }),
    ]);
    locations = allLocations;
    usersWithAssignments = await Promise.all(
      memberships.map(async (membership): Promise<OrganizationUser> => {
        const [profileResult, assignments] = await Promise.all([
          dynamodb.send(
            new GetCommand({
              TableName: tableNames.users,
              Key: { userId: membership.userId },
            }),
          ),
          queryAll<StaffLocationAssignment>({
            TableName: tableNames.assignments,
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
      }),
    );
  } else {
    const [profileResult, assignments] = await Promise.all([
      dynamodb.send(
        new GetCommand({
          TableName: tableNames.users,
          Key: { userId: callerUserId },
        }),
      ),
      queryAll<StaffLocationAssignment>({
        TableName: tableNames.assignments,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": callerUserId },
      }),
    ]);
    const assignedLocationIds = assignments
      .filter(
        (assignment) =>
          assignment.organizationId === organizationId &&
          assignment.status === "ACTIVE",
      )
      .map((assignment) => assignment.locationId);
    const locationResults = await Promise.all(
      assignedLocationIds.map((locationId) =>
        dynamodb.send(
          new GetCommand({
            TableName: tableNames.locations,
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

    const profile = profileResult.Item;
    usersWithAssignments = [
      {
        userId: callerUserId,
        email: profile?.email ?? callerMembership.Item.email,
        givenName: profile?.givenName,
        familyName: profile?.familyName,
        role: callerMembership.Item.role,
        status: callerMembership.Item.status,
        userStatus: profile?.status,
        locationIds: locations.map((location) => location.locationId),
      },
    ];
  }

  const locationsWithUsers: OrganizationLocationDetails[] = locations.map(
    (location) => ({
      ...location,
      assignedUsers: usersWithAssignments
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
    organization: organizationResult.Item,
    users: usersWithAssignments,
    locations: locationsWithUsers,
  });
};

/**
 * Updates the fields of an organization that an organization admin may edit.
 * Status is deliberately excluded; only platform admins can activate or
 * deactivate an organization.
 */
async function handleUpdate(
  event: APIGatewayProxyEvent,
  organizationsTable: string,
  organizationId: string,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<{ name?: unknown }>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }
  if (
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.trim().length > 120
  ) {
    return jsonResponse(event, 400, {
      message: "name must contain between 1 and 120 characters",
    });
  }

  return applyUpdates(event, organizationsTable, organizationId, {
    name: body.name.trim(),
  });
}

/**
 * Writes a set of field updates to the organization and returns the new item.
 */
async function applyUpdates(
  event: APIGatewayProxyEvent,
  organizationsTable: string,
  organizationId: string,
  updates: Record<string, string>,
): Promise<APIGatewayProxyResult> {
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

  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: organizationsTable,
      Key: { organizationId },
      UpdateExpression: `SET ${expressions.join(", ")}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
      ConditionExpression: "attribute_exists(organizationId)",
      ReturnValues: "ALL_NEW",
    }),
  );
  return jsonResponse(event, 200, { organization: result.Attributes });
}
