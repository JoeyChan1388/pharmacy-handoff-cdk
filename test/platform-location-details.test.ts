import { jest } from "@jest/globals";
import { type AnyMock, makeEvent, parseBody, routeByTable } from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
  queryAll: jest.fn(),
}));

process.env.PLATFORM_ADMIN_USER_IDS = "platform-admin";

import { dynamodb, queryAll } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/platform/getLocationDetailsResolver";

const sendMock = dynamodb.send as unknown as AnyMock;
const queryAllMock = queryAll as unknown as AnyMock;

function adminEvent(sub = "platform-admin", httpMethod = "GET") {
  return makeEvent({
    sub,
    httpMethod,
    pathParameters: { organizationId: "org-1", locationId: "loc-1" },
  });
}

describe("GET platform location details", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME = "memberships";
    process.env.USERS_TABLE_NAME = "users";
    process.env.LOCATIONS_TABLE_NAME = "locations";
    process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME = "assignments";
  });

  test("rejects callers who are not platform admins", async () => {
    const response = await handler(adminEvent("someone-else"));

    expect(response.statusCode).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("rejects non-GET methods", async () => {
    const response = await handler(adminEvent("platform-admin", "DELETE"));

    expect(response.statusCode).toBe(405);
  });

  test("returns 404 when the location is not in the organization", async () => {
    routeByTable(sendMock, { locations: () => ({}) });
    queryAllMock.mockResolvedValue([]);

    const response = await handler(adminEvent());

    expect(response.statusCode).toBe(404);
  });

  test("returns the location with assigned users from this organization only", async () => {
    routeByTable(sendMock, {
      locations: () => ({
        Item: {
          organizationId: "org-1",
          locationId: "loc-1",
          name: "Main",
          status: "INACTIVE",
        },
      }),
      users: () => ({
        Item: { email: "a@example.com", givenName: "A", familyName: "B" },
      }),
      memberships: () => ({ Item: { role: "STAFF" } }),
    });
    queryAllMock.mockResolvedValue([
      {
        userId: "user-1",
        organizationId: "org-1",
        locationId: "loc-1",
        status: "ACTIVE",
      },
      // Same location id under another organization must be ignored.
      {
        userId: "user-2",
        organizationId: "org-9",
        locationId: "loc-1",
        status: "ACTIVE",
      },
    ]);

    const response = await handler(adminEvent());
    const body = parseBody(response);

    expect(response.statusCode).toBe(200);
    expect(body.location).toMatchObject({ locationId: "loc-1" });
    expect(body.assignedUsers).toEqual([
      {
        userId: "user-1",
        role: "STAFF",
        status: "ACTIVE",
        email: "a@example.com",
        givenName: "A",
        familyName: "B",
      },
    ]);
  });
});
