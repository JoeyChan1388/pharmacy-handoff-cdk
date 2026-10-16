import type { APIGatewayProxyEvent } from "aws-lambda";

import { normalizeEmail, parseJsonBody } from "../lambda/shared/validation";

function eventWithBody(body: string): APIGatewayProxyEvent {
  return { body } as APIGatewayProxyEvent;
}

describe("shared Lambda validation", () => {
  test("parses JSON object request bodies", () => {
    expect(
      parseJsonBody<{ name: string }>(eventWithBody('{"name":"Acme"}')),
    ).toEqual({
      name: "Acme",
    });
  });

  test.each(["", "not-json", "null", "[]", '"string"'])(
    "rejects non-object or invalid JSON bodies: %s",
    (body) => {
      expect(parseJsonBody(eventWithBody(body))).toBeUndefined();
    },
  );

  test("normalizes valid email addresses", () => {
    expect(normalizeEmail("  ADMIN@Example.COM  ")).toBe("admin@example.com");
  });

  test("rejects invalid email addresses", () => {
    expect(normalizeEmail("not-an-email")).toBeUndefined();
    expect(normalizeEmail(null)).toBeUndefined();
  });
});
