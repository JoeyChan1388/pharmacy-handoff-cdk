import type { APIGatewayProxyEvent } from "aws-lambda";

/**
 * Parses the JSON body of an API Gateway event and returns it as an object of
 * type T. If the body is not valid JSON or is not an object, it returns
 * undefined.
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
 * Normalizes an email address by trimming whitespace and converting it to
 * lowercase. Returns undefined if the input is not a string or does not look
 * like an email address.
 *
 * @param value The value to normalize
 * @returns The normalized email address or undefined
 */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

/**
 * Validates an optional text field from a request body. Missing, null, or
 * empty values return undefined. Non-string values or strings longer than
 * maxLength throw an error whose message is safe to return to the caller.
 *
 * @param value The value to validate
 * @param field The name of the field, used in error messages
 * @param maxLength The maximum allowed length for the trimmed string
 * @returns The trimmed string or undefined
 */
export function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new Error(
      `${field} must be a string no longer than ${maxLength} characters`,
    );
  }
  return value.trim();
}

/**
 * Validates a required text field from a request body, returning the trimmed
 * string or undefined when it is missing, empty, or longer than maxLength.
 *
 * @param value The value to validate
 * @param maxLength The maximum allowed length for the trimmed string
 * @returns The trimmed string or undefined
 */
export function requiredText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : undefined;
}
