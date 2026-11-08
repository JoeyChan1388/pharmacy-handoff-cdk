import { dynamodb } from "../shared/dynamodb";
import { jsonResponse } from "../shared/http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  authorizePlatformAdmin,
  getCallerUserId,
} from "../shared/authorization";
import {
  getDetails,
  loadConfig,
} from "../organizations/manageOrganizationDetailsResolver";

import type { OrganizationMembership } from "../shared/types";
import type { OrganizationRecord } from "../shared/organizations";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * GetPlatformOrganizationDetailsResolver Handler
 *
 * Handles GET /platform/organizations/{organizationId}/details. Returns the
 * same organization, staff, and locations payload as the member-facing
 * details route, but is gated on platform admin status instead of membership.
 * Platform admins see the full admin view, including inactive organizations.
 *
 * @param event The API Gateway event
 * @returns A 200 response with organization, users, and locations; 403 for
 * non-admins; or 404 when the organization does not exist.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const authorizationError = authorizePlatformAdmin(event);
  if (authorizationError) return authorizationError;

  const organizationId = event.pathParameters?.organizationId;
  if (!organizationId) {
    return jsonResponse(event, 400, { message: "organizationId is required" });
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(event, 405, { message: "Method not allowed" });
  }

  const config = loadConfig();
  const result = await dynamodb.send(
    new GetCommand({
      TableName: config.organizationsTable,
      Key: { organizationId },
      ConsistentRead: true,
    }),
  );
  if (!result.Item) {
    return jsonResponse(event, 404, { message: "Organization not found" });
  }

  /**
   * Admin View Without Membership
   *
   * getDetails builds the admin view from the membership's role and
   * organization, so a platform admin is represented by a synthetic admin
   * membership that is never stored.
   */
  const platformAdminMembership: OrganizationMembership = {
    userId: getCallerUserId(event) as string,
    organizationId,
    role: "ADMIN",
  };
  return getDetails(
    event,
    config,
    platformAdminMembership,
    result.Item as OrganizationRecord,
  );
};
