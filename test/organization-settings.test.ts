import { jest } from "@jest/globals";
import {
  type AnyMock,
  makeEvent,
  parseBody,
  routeByTable,
  sentCommands,
} from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
}));
jest.mock("../lambda/shared/avatars", () => ({
  ...jest.requireActual<object>("../lambda/shared/avatars"),
  s3: { send: jest.fn() },
  signedAvatarUrl: jest.fn(async (key: string) => `https://signed/${key}`),
}));
jest.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: jest.fn(async () => ({
    url: "https://bucket.s3.amazonaws.com/",
    fields: { key: "k" },
  })),
}));

import { s3 } from "../lambda/shared/avatars";
import { dynamodb } from "../lambda/shared/dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { handler } from "../lambda/organizations/manageOrganizationSettingsResolver";

const dynamoMock = dynamodb.send as unknown as AnyMock;
const s3Mock = s3.send as unknown as AnyMock;
const presignMock = createPresignedPost as unknown as AnyMock;

const SETTINGS = "/organizations/{organizationId}/settings";
const LOGO = "/organizations/{organizationId}/logo";

const call = (
  httpMethod: string,
  resource: string,
  body?: unknown,
  sub = "u1",
) =>
  handler(
    makeEvent({
      sub,
      httpMethod,
      resource,
      pathParameters: { organizationId: "org-1" },
      body: body === undefined ? null : JSON.stringify(body),
    } as never),
  );

/** Memberships by user, and one stored organization. */
function mockData(
  role: "ADMIN" | "STAFF" | null,
  organization: Record<string, unknown> = {
    organizationId: "org-1",
    name: "Org",
    status: "ACTIVE",
  },
) {
  routeByTable(dynamoMock, {
    memberships: () => (role ? { Item: { role, status: "ACTIVE" } } : {}),
    organizations: (command) => {
      if (command.constructor.name === "GetCommand") {
        return { Item: organization };
      }
      const applied = Object.fromEntries(
        Object.entries(
          (command.input.ExpressionAttributeValues ?? {}) as Record<
            string,
            unknown
          >,
        ).map(([name, value]) => [name.slice(1), value]),
      );
      return { Attributes: { ...organization, ...applied } };
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PROFILE_PICTURES_BUCKET_NAME = "bucket";
  process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME = "memberships";
  process.env.ORGANIZATIONS_TABLE_NAME = "organizations";
  process.env.AWS_REGION = "ca-central-1";
  s3Mock.mockResolvedValue({});
});

describe("GET settings", () => {
  test("lets any active member read, with a signed logo URL and the data region", async () => {
    mockData("STAFF", {
      organizationId: "org-1",
      name: "Shoppers",
      status: "ACTIVE",
      contactEmail: "a@b.co",
      logoKey: "organizations/org-1/logos/x",
    });

    const response = await call("GET", SETTINGS);
    const body = parseBody(response);

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      name: "Shoppers",
      contactEmail: "a@b.co",
      logoUrl: "https://signed/organizations/org-1/logos/x",
      dataRegion: "ca-central-1",
    });
    expect(body.logoKey).toBeUndefined();
  });

  test("rejects non-members", async () => {
    mockData(null);

    expect((await call("GET", SETTINGS)).statusCode).toBe(403);
  });
});

describe("admin-only writes", () => {
  test("staff cannot update settings or upload a logo", async () => {
    mockData("STAFF");

    expect((await call("PATCH", SETTINGS, { name: "Hacked" })).statusCode).toBe(
      403,
    );
    expect(
      (await call("POST", LOGO, { contentType: "image/png" })).statusCode,
    ).toBe(403);
    expect(sentCommands(dynamoMock, "UpdateCommand")).toHaveLength(0);
    expect(presignMock).not.toHaveBeenCalled();
  });

  test("non-members cannot write", async () => {
    mockData(null);

    expect((await call("PATCH", SETTINGS, { name: "x" })).statusCode).toBe(403);
    expect(
      (await call("POST", LOGO, { contentType: "image/png" })).statusCode,
    ).toBe(403);
  });

  test("an admin of another organization cannot write to this one", async () => {
    // The membership lookup is keyed by the path's organization, so the caller
    // has no membership here even if they administer another organization.
    mockData(null);

    const response = await call(
      "PATCH",
      SETTINGS,
      { name: "x" },
      "admin-of-org-2",
    );

    expect(response.statusCode).toBe(403);
  });
});

describe("PATCH settings", () => {
  beforeEach(() => mockData("ADMIN"));

  test("validates fields", async () => {
    for (const body of [
      {},
      { name: "  " },
      { name: "x".repeat(121) },
      { contactEmail: "not-an-email" },
      { phone: "abc" },
      { timeZone: "Mars/Olympus" },
      { logoKey: "organizations/org-2/logos/x" },
      { logoKey: "organizations/org-1/logos/" },
      { logoKey: 5 },
    ]) {
      expect((await call("PATCH", SETTINGS, body)).statusCode).toBe(400);
    }
    expect(sentCommands(dynamoMock, "UpdateCommand")).toHaveLength(0);
  });

  test("updates text fields, normalising the email", async () => {
    const response = await call("PATCH", SETTINGS, {
      name: " New Name ",
      contactEmail: " Admin@Pharmacy.CA ",
      phone: "(416) 555-0123",
      timeZone: "America/Toronto",
    });

    expect(response.statusCode).toBe(200);
    const [update] = sentCommands(dynamoMock, "UpdateCommand");
    expect(update.input.Key).toEqual({ organizationId: "org-1" });
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ":name": "New Name",
      ":contactEmail": "admin@pharmacy.ca",
      ":phone": "(416) 555-0123",
      ":timeZone": "America/Toronto",
    });
  });

  test("clears optional fields with null or an empty string", async () => {
    await call("PATCH", SETTINGS, { contactEmail: null, phone: "" });

    const [update] = sentCommands(dynamoMock, "UpdateCommand");
    expect(update.input.UpdateExpression).toContain(
      "REMOVE #contactEmail, #phone",
    );
  });

  test("never changes the status or other protected fields", async () => {
    await call("PATCH", SETTINGS, {
      name: "x",
      status: "INACTIVE",
      organizationId: "evil",
    });

    const [update] = sentCommands(dynamoMock, "UpdateCommand");
    const fields = Object.values(update.input.ExpressionAttributeNames);
    expect(fields).not.toContain("status");
    expect(fields).not.toContain("organizationId");
    expect(update.input.Key).toEqual({ organizationId: "org-1" });
  });

  describe("logo", () => {
    test("rejects a key that was never uploaded", async () => {
      const error = new Error("nf");
      error.name = "NotFound";
      s3Mock.mockRejectedValue(error);

      const response = await call("PATCH", SETTINGS, {
        logoKey: "organizations/org-1/logos/abc",
      });

      expect(response.statusCode).toBe(400);
      expect(sentCommands(dynamoMock, "UpdateCommand")).toHaveLength(0);
    });

    test("rejects an uploaded object with the wrong type or size", async () => {
      for (const head of [
        { ContentType: "text/html", ContentLength: 10 },
        { ContentType: "image/png", ContentLength: 6 * 1024 * 1024 },
      ]) {
        s3Mock.mockResolvedValueOnce(head);
        const response = await call("PATCH", SETTINGS, {
          logoKey: "organizations/org-1/logos/abc",
        });
        expect(response.statusCode).toBe(400);
      }
    });

    test("saves a valid logo and deletes the previous one", async () => {
      mockData("ADMIN", {
        organizationId: "org-1",
        name: "Org",
        status: "ACTIVE",
        logoKey: "organizations/org-1/logos/old",
      });
      s3Mock.mockImplementation(
        async (command: { constructor: { name: string } }) =>
          command.constructor.name === "HeadObjectCommand"
            ? { ContentType: "image/png", ContentLength: 1000 }
            : {},
      );

      const response = await call("PATCH", SETTINGS, {
        logoKey: "organizations/org-1/logos/new",
      });

      expect(response.statusCode).toBe(200);
      expect(parseBody(response).logoUrl).toBe(
        "https://signed/organizations/org-1/logos/new",
      );
      const [del] = sentCommands(s3Mock, "DeleteObjectCommand");
      expect(del.input).toMatchObject({
        Bucket: "bucket",
        Key: "organizations/org-1/logos/old",
      });
    });

    test("removing the logo deletes the object", async () => {
      mockData("ADMIN", {
        organizationId: "org-1",
        name: "Org",
        status: "ACTIVE",
        logoKey: "organizations/org-1/logos/old",
      });

      const response = await call("PATCH", SETTINGS, { logoKey: null });

      expect(response.statusCode).toBe(200);
      const [update] = sentCommands(dynamoMock, "UpdateCommand");
      expect(update.input.UpdateExpression).toContain("REMOVE #logoKey");
      expect(sentCommands(s3Mock, "DeleteObjectCommand")).toHaveLength(1);
    });
  });
});

describe("POST logo", () => {
  beforeEach(() => mockData("ADMIN"));

  test("rejects non-image content types", async () => {
    for (const contentType of ["text/html", "image/svg+xml", undefined, 3]) {
      expect((await call("POST", LOGO, { contentType })).statusCode).toBe(400);
    }
    expect(presignMock).not.toHaveBeenCalled();
  });

  test("returns a presigned POST pinned to the organization's prefix, type and size", async () => {
    const response = await call("POST", LOGO, { contentType: "image/webp" });
    const body = parseBody(response);

    expect(response.statusCode).toBe(200);
    expect(body.key).toMatch(/^organizations\/org-1\/logos\/[0-9a-f-]{36}$/);

    const [, options] = presignMock.mock.calls[0] as [unknown, any];
    expect(options).toMatchObject({
      Bucket: "bucket",
      Key: body.key,
      Fields: { "Content-Type": "image/webp" },
      Expires: 300,
    });
    expect(options.Conditions).toEqual(
      expect.arrayContaining([
        ["content-length-range", 1, 5 * 1024 * 1024],
        ["eq", "$Content-Type", "image/webp"],
      ]),
    );
  });
});

test("rejects unknown routes and a missing caller", async () => {
  mockData("ADMIN");

  expect((await call("DELETE", SETTINGS)).statusCode).toBe(405);
  expect(
    (
      await handler(
        makeEvent({
          httpMethod: "GET",
          resource: SETTINGS,
          pathParameters: { organizationId: "org-1" },
          requestContext: {},
        } as never),
      )
    ).statusCode,
  ).toBe(401);
});
