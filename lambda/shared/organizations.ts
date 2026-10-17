import { dynamodb } from "./dynamodb";
import { jsonResponse } from "./http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

import type { OrganizationMembership } from "./types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * OrganizationRecord
 *
 * An organization item as stored in the organizations table.
 */
export interface OrganizationRecord {
  name?: string;
  status?: string;
  organizationId: string;
}

/**
 * OrganizationAccess
 *
 * The caller's membership and the organization they are acting on, returned
 * once both have passed the access checks.
 */
export interface OrganizationAccess {
  organization: OrganizationRecord;
  membership: OrganizationMembership;
}

/**
 * OrganizationAccessOptions
 *
 * Table names and the roles allowed to pass the access check.
 */
export interface OrganizationAccessOptions {
  membershipsTable: string;
  organizationsTable: string;
  allowedRoles: OrganizationMembership["role"][];
}

/**
 * Loads the caller's membership and the target organization, enforcing the
 * common rules every organization-scoped endpoint shares:
 *
 * - the membership must exist, be ACTIVE, and hold one of the allowed roles
 * - the organization must exist and not be INACTIVE
 *
 * @param event The API Gateway event, used to build error responses
 * @param callerUserId The authenticated caller's user ID
 * @param organizationId The organization from the request path
 * @param options Table names and allowed roles
 * @returns The membership and organization, or an error response to return
 * directly to the caller
 */
export async function loadOrganizationAccess(
  event: APIGatewayProxyEvent,
  callerUserId: string,
  organizationId: string,
  options: OrganizationAccessOptions,
): Promise<OrganizationAccess | APIGatewayProxyResult> {
  const membershipResult = await dynamodb.send(
    new GetCommand({
      TableName: options.membershipsTable,
      Key: { organizationId, userId: callerUserId },
      ConsistentRead: true,
    }),
  );
  const membership = membershipResult.Item as
    OrganizationMembership | undefined;

  if (
    !membership ||
    membership.status !== "ACTIVE" ||
    !options.allowedRoles.includes(membership.role)
  ) {
    const message = options.allowedRoles.includes("STAFF")
      ? "Active organization membership required"
      : "Organization admin access required";
    return jsonResponse(event, 403, { message });
  }

  const organizationResult = await dynamodb.send(
    new GetCommand({
      TableName: options.organizationsTable,
      Key: { organizationId },
      ConsistentRead: true,
    }),
  );
  const organization = organizationResult.Item as
    OrganizationRecord | undefined;

  if (!organization) {
    return jsonResponse(event, 404, { message: "Organization not found" });
  }
  if (organization.status === "INACTIVE") {
    return jsonResponse(event, 409, { message: "Organization is inactive" });
  }

  return { organization, membership };
}

/**
 * Narrows the result of loadOrganizationAccess to the error case.
 *
 * @param result The access result
 * @returns True if the result is an error response
 */
export function isAccessError(
  result: OrganizationAccess | APIGatewayProxyResult,
): result is APIGatewayProxyResult {
  return "statusCode" in result;
}
