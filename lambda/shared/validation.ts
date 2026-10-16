import type { APIGatewayProxyEvent } from "aws-lambda";

/**
 * Parses the JSON body of an API Gateway event and returns it as an object of type T.
 * If the body is not valid JSON or is not an object, it returns undefined.
 *
 * @param event The API Gateway event
 * @returns The parsed JSON body as an object of type T, or undefined if invalid
 */
export function parseJsonBody<T extends object>(
  event: APIGatewayProxyEvent,
): T | undefined {
  try {
    const body: unknown = JSON.parse(event.body ?? "");
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as T)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes an email address by trimming whitespace and converting it to lowercase.
 * If the input is not a string, it returns undefined. If the input is a string,
 * it returns the normalized email address.
 *
 * @param value The value to normalize
 * @returns The normalized email address or undefined
 */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}
