import { jest } from "@jest/globals";
import { type AnyMock, makeEvent, parseBody, routeByTable } from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
  queryAll: jest.fn(),
}));

process.env.PLATFORM_ADMIN_USER_IDS = "platform-admin";

import { dynamodb, queryAll } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/platform/getUserOrganizationsResolver";

const sendMock = dynamodb.send as unknown as AnyMock;
const queryAllMock = queryAll as unknown as AnyMock;

function adminEvent(sub = "platform-admin", httpMethod = "GET") {
  return makeEvent({
    sub,
    httpMethod,
    pathParameters: { userId: "user-1" },
  });
}

describe("GET platform user organizations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ORGANIZATIONS_TABLE_NAME = "organizations";
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
    const response = await handler(adminEvent("platform-admin", "POST"));

    expect(response.statusCode).toBe(405);
  });

  test("returns 404 when the user does not exist", async () => {
    routeByTable(sendMock, { users: () => ({}) });
    queryAllMock.mockResolvedValue([]);

    const response = await handler(adminEvent());

    expect(response.statusCode).toBe(404);
  });

  test("returns every membership, including inactive ones, with assigned locations", async () => {
    routeByTable(sendMock, {
      users: () => ({ Item: { userId: "user-1" } }),
      organizations: (command) =>
        command.input.Key.organizationId === "org-1"
          ? { Item: { name: "Active Org", status: "ACTIVE" } }
          : { Item: { name: "Closed Org", status: "INACTIVE" } },
      locations: (command) => ({
        Item: {
          organizationId: command.input.Key.organizationId,
          locationId: command.input.Key.locationId,
          name: "Main",
          city: "Oshawa",
          province: "ON",
          status: "ACTIVE",
          addressLine1: "not exposed",
        },
      }),
    });
    queryAllMock.mockImplementation(async (input: { TableName: string }) => {
      switch (input.TableName) {
        case "memberships":
          return [
            {
              userId: "user-1",
              organizationId: "org-1",
              role: "STAFF",
              status: "ACTIVE",
            },
            {
              userId: "user-1",
              organizationId: "org-2",
              role: "ADMIN",
              status: "INVITED",
            },
          ];
        case "assignments":
          return [
            { organizationId: "org-1", locationId: "loc-1", status: "ACTIVE" },
            { organizationId: "org-1", locationId: "loc-2", status: "REMOVED" },
          ];
        default:
          throw new Error(`Unexpected table: ${input.TableName}`);
      }
    });

    const response = await handler(adminEvent());
    const { organizations } = parseBody(response);

    expect(response.statusCode).toBe(200);
    expect(organizations).toHaveLength(2);
    expect(organizations[0]).toMatchObject({
      organizationId: "org-1",
      name: "Active Org",
      role: "STAFF",
      membershipStatus: "ACTIVE",
    });
    // Only the active assignment is returned, trimmed to the summary fields.
    expect(organizations[0].locations).toEqual([
      {
        locationId: "loc-1",
        name: "Main",
        city: "Oshawa",
        province: "ON",
        status: "ACTIVE",
      },
    ]);
    expect(organizations[1]).toMatchObject({
      organizationStatus: "INACTIVE",
      membershipStatus: "INVITED",
      locations: [],
    });
  });
});
