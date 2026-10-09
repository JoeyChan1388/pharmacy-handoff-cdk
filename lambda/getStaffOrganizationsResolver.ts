import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type {
  CognitoAuthorizerClaims,
  OrganizationLocation,
  OrganizationMembership,
  StaffLocationAssignment,
  StaffOrganizationSummary,
} from "./types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
);

/**
 * Creates a standardized API response structure with appropriate headers
 * based on the request's origin.
 *
 * @param event The API Gateway proxy event
 * @param statusCode The HTTP status code
 * @param body The response body
 * @returns The APIGatewayProxyResult
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
 * Queries a DynamoDB table using the provided key condition expression and
 * expression attribute values. It handles pagination and returns all matching
 * items.
 *
 * @template T The type of the items to be returned.
 * @param tableName The name of the DynamoDB table to query.
 * @param keyConditionExpression The key condition expression for the query.
 * @param expressionAttributeValues The values for the expression attributes
 * used in the key condition expression.
 * @param indexName Optional. The name of the index to query, if applicable.
 * @returns A promise that resolves to an array of items of type T matching the query.
 */
async function queryAll<T>(
  tableName: string,
  keyConditionExpression: string,
  expressionAttributeValues: Record<string, string>,
  indexName?: string,
): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: tableName,
        ...(indexName ? { IndexName: indexName } : {}),
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as T[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

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
  const authorizer = event.requestContext.authorizer as
    | CognitoAuthorizerClaims
    | undefined;
  const userId = authorizer?.claims?.sub;

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

  const memberships = await queryAll<OrganizationMembership>(
    tableNames.memberships!,
    "userId = :userId",
    { ":userId": userId },
    "ByUser",
  );
  const activeMemberships = memberships.filter(
    (membership) => membership.status === "ACTIVE",
  );

  const assignments = await queryAll<StaffLocationAssignment>(
    tableNames.assignments!,
    "userId = :userId",
    { ":userId": userId },
  );
  const activeAssignments = assignments.filter(
    (assignment) => assignment.status === "ACTIVE",
  );

  const organizations = await Promise.all(
    activeMemberships.map(
      async (membership): Promise<StaffOrganizationSummary> => {
        const organizationResult = await dynamodb.send(
          new GetCommand({
            TableName: tableNames.organizations,
            Key: { organizationId: membership.organizationId },
          }),
        );

        const locations: OrganizationLocation[] =
          membership.role === "ADMIN"
            ? await queryAll<OrganizationLocation>(
                tableNames.locations!,
                "organizationId = :organizationId",
                { ":organizationId": membership.organizationId },
              )
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
                items.filter((item): item is OrganizationLocation =>
                  Boolean(item),
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

  return response(event, 200, { organizations });
};
