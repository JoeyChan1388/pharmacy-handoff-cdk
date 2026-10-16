import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGIN ?? "")
    .split(",")
    .filter(Boolean),
);

/**
 * Creates a response object for the API Gateway
 *
 * @param event The API Gateway event
 * @param statusCode The HTTP status code
 * @param body The response body
 * @returns The API Gateway response object
 */
export function jsonResponse(
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
