import { jsonResponse } from "./http";

import type { CognitoAuthorizerClaims } from "./types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const platformAdminUserIds = new Set(
  (process.env.PLATFORM_ADMIN_USER_IDS ?? "").split(",").filter(Boolean),
);

/**
 * Gets the caller's user ID from the API Gateway event
 *
 * @param event The API Gateway event
 * @returns The caller's user ID, or undefined if not found
 */
export function getCallerUserId(
  event: APIGatewayProxyEvent,
): string | undefined {
  const claims = event.requestContext.authorizer as
    CognitoAuthorizerClaims | undefined;
  return claims?.claims?.sub;
}

/**
 * Authorizes the caller as a platform admin based on their user ID
 *
 * @param event The API Gateway event
 * @returns An APIGatewayProxyResult with an error message if unauthorized, or
 * undefined if authorized
 */
export function authorizePlatformAdmin(
  event: APIGatewayProxyEvent,
): APIGatewayProxyResult | undefined {
  const callerUserId = getCallerUserId(event);
  if (!callerUserId) {
    return jsonResponse(event, 401, { message: "Unauthorized" });
  }
  if (!platformAdminUserIds.has(callerUserId)) {
    return jsonResponse(event, 403, {
      message: "Platform admin access required",
    });
  }
  return undefined;
}
