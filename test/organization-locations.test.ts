import { jest } from "@jest/globals";
import {
  type AnyMock,
  conditionalCheckFailed,
  makeEvent,
  parseBody,
  routeByTable,
  type SendHandler,
  sentCommands,
} from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
  queryAll: jest.fn(),
}));

import { dynamodb, queryAll } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/organizations/manageOrganizationLocationsResolver";

const sendMock = dynamodb.send as unknown as AnyMock;
const queryAllMock = queryAll as unknown as AnyMock;

const ACTIVE_ORG = { organizationId: "org-1", name: "Org", status: "ACTIVE" };

function mockAccess(
  role: "ADMIN" | "STAFF",
  extra: Record<string, SendHandler> = {},
) {
  routeByTable(sendMock, {
    memberships: () => ({ Item: { role, status: "ACTIVE" } }),
    organizations: () => ({ Item: ACTIVE_ORG }),
    ...extra,
  });
}

function event(
  httpMethod: string,
  body?: Record<string, unknown>,
  locationId?: string,
) {
  return makeEvent({
    httpMethod,
    body: body ? JSON.stringify(body) : null,
    pathParameters: {
      organizationId: "org-1",
      ...(locationId && { locationId }),
    },
  });
}

describe("organization locations resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ORGANIZATIONS_TABLE_NAME = "organizations";
    process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME = "memberships";
    process.env.LOCATIONS_TABLE_NAME = "locations";
  });

  test("rejects callers who are not organization admins", async () => {
    mockAccess("STAFF");

    const result = await handler(event("GET"));

    expect(result.statusCode).toBe(403);
    expect(parseBody(result).message).toBe(
      "Organization admin access required",
    );
  });

  test("lists every location in the organization", async () => {
    mockAccess("ADMIN");
    queryAllMock.mockResolvedValue([
      { locationId: "loc-1" },
      { locationId: "loc-2" },
    ]);

    const result = await handler(event("GET"));

    expect(result.statusCode).toBe(200);
    expect(parseBody(result).locations).toHaveLength(2);
    expect(queryAllMock).toHaveBeenCalledWith(
      expect.objectContaining({ TableName: "locations" }),
    );
  });

  test("creates an active location with trimmed fields", async () => {
    mockAccess("ADMIN", { locations: () => ({}) });

    const result = await handler(
      event("POST", {
        name: " Main St ",
        city: "Oshawa",
        province: "ON",
        phone: "",
      }),
    );
    const { location } = parseBody(result);

    expect(result.statusCode).toBe(201);
    expect(location).toMatchObject({
      organizationId: "org-1",
      name: "Main St",
      city: "Oshawa",
      province: "ON",
      status: "ACTIVE",
    });
    expect(location.phone).toBeUndefined();
    expect(location.locationId).toEqual(expect.any(String));
    const [put] = sentCommands(sendMock, "PutCommand");
    expect(put.input.ConditionExpression).toContain("attribute_not_exists");
  });

  test("requires name, city, and province on create", async () => {
    mockAccess("ADMIN");

    const result = await handler(event("POST", { name: "Only a name" }));

    expect(result.statusCode).toBe(400);
    expect(parseBody(result).message).toBe(
      "name, city, and province are required",
    );
    expect(sentCommands(sendMock, "PutCommand")).toHaveLength(0);
  });

  test("rejects fields over their length limit", async () => {
    mockAccess("ADMIN");

    const result = await handler(
      event("PATCH", { postalCode: "x".repeat(21) }, "loc-1"),
    );

    expect(result.statusCode).toBe(400);
    expect(parseBody(result).message).toContain("postalCode");
  });

  test("returns 404 when updating a missing location", async () => {
    mockAccess("ADMIN", {
      locations: () => {
        throw conditionalCheckFailed();
      },
    });

    const result = await handler(
      event("PATCH", { name: "Renamed" }, "missing"),
    );

    expect(result.statusCode).toBe(404);
    expect(parseBody(result).message).toBe("Location not found");
  });

  test("soft-deletes a location by marking it inactive", async () => {
    mockAccess("ADMIN", {
      locations: (command) => ({
        Attributes: {
          locationId: "loc-1",
          status: command.input.ExpressionAttributeValues[":status"],
        },
      }),
    });

    const result = await handler(event("DELETE", undefined, "loc-1"));

    expect(result.statusCode).toBe(200);
    expect(parseBody(result).location.status).toBe("INACTIVE");
    const [update] = sentCommands(sendMock, "UpdateCommand");
    expect(update.input.Key).toEqual({
      organizationId: "org-1",
      locationId: "loc-1",
    });
    expect(update.input.ConditionExpression).toBe(
      "attribute_exists(locationId)",
    );
  });

  test("rejects unsupported methods", async () => {
    mockAccess("ADMIN");

    const result = await handler(event("PUT", {}, "loc-1"));

    expect(result.statusCode).toBe(405);
  });
});
