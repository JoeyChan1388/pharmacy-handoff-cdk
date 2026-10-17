import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { dynamodb, queryAll } from "../shared/dynamodb";
import { jsonResponse as response } from "../shared/http";
import { getCallerUserId } from "../shared/authorization";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type {
  OrganizationLocation,
  OrganizationMembership,
  StaffLocationAssignment,
  StaffOrganizationSummary,
} from "../shared/types";

/**
 * GetStaffOrganizationsResolver Handler
 *
 * This Lambda function retrieves the organizations and locations that a staff
 * member is associated with. It requires the user to be authenticated via
 * Cognito, and their unique identifier (sub) is used to query the relevant
 * DynamoDB tables.
 *
 * @param event The API Gateway proxy event containing the request context and
 * authorizer claims.
 * @returns An APIGatewayProxyResult containing the staff member's organizations
 * and locations, or an error message if unauthorized.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getCallerUserId(event);

  if (!userId) {
    return response(event, 401, { message: "Unauthorized" });
  }

  const tableNames = {
    organizations: process.env.ORGANIZATIONS_TABLE_NAME,
    locations: process.env.LOCATIONS_TABLE_NAME,
    memberships: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
    assignments: process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME,
  };
  if (Object.values(tableNames).some((tableName) => !tableName)) {
    throw new Error(
      "Staff organizations Lambda is missing table configuration",
    );
  }

  const memberships = await queryAll<OrganizationMembership>({
    TableName: tableNames.memberships!,
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": userId },
    IndexName: "ByUser",
  });
  const activeMemberships = memberships.filter(
    (membership) => membership.status === "ACTIVE",
  );

  const assignments = await queryAll<StaffLocationAssignment>({
    TableName: tableNames.assignments!,
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": userId },
  });
  const activeAssignments = assignments.filter(
    (assignment) => assignment.status === "ACTIVE",
  );

  const organizations = await Promise.all(
    activeMemberships.map(
      async (membership): Promise<StaffOrganizationSummary | undefined> => {
        const organizationResult = await dynamodb.send(
          new GetCommand({
            TableName: tableNames.organizations,
            Key: { organizationId: membership.organizationId },
          }),
        );
        if (organizationResult.Item?.status === "INACTIVE") return undefined;

        const locations: OrganizationLocation[] =
          membership.role === "ADMIN"
            ? await queryAll<OrganizationLocation>({
                TableName: tableNames.locations!,
                KeyConditionExpression: "organizationId = :organizationId",
                ExpressionAttributeValues: {
                  ":organizationId": membership.organizationId,
                },
              })
            : await Promise.all(
                activeAssignments
                  .filter(
                    (assignment) =>
                      assignment.organizationId === membership.organizationId,
                  )
                  .map(async (assignment) => {
                    const result = await dynamodb.send(
                      new GetCommand({
                        TableName: tableNames.locations,
                        Key: {
                          organizationId: membership.organizationId,
                          locationId: assignment.locationId,
                        },
                      }),
                    );
                    return result.Item as OrganizationLocation | undefined;
                  }),
              ).then((items) =>
                items.filter(
                  (item): item is OrganizationLocation =>
                    item !== undefined && item.status !== "INACTIVE",
                ),
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

  return response(event, 200, {
    organizations: organizations.filter(
      (organization): organization is StaffOrganizationSummary =>
        Boolean(organization),
    ),
  });
};
