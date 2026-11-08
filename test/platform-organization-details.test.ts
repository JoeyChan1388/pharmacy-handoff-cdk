import { jest } from "@jest/globals";
import { type AnyMock, makeEvent, parseBody, routeByTable } from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
  queryAll: jest.fn(),
}));

process.env.PLATFORM_ADMIN_USER_IDS = "platform-admin";

import { dynamodb, queryAll } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/platform/getOrganizationDetailsResolver";

const sendMock = dynamodb.send as unknown as AnyMock;
const queryAllMock = queryAll as unknown as AnyMock;

function adminEvent(sub = "platform-admin", httpMethod = "GET") {
  return makeEvent({
    sub,
    httpMethod,
    pathParameters: { organizationId: "org-1" },
  });
}

describe("GET platform organization details", () => {
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

  test("returns 404 for an unknown organization", async () => {
    routeByTable(sendMock, { organizations: () => ({}) });

    const response = await handler(adminEvent());

    expect(response.statusCode).toBe(404);
  });

  test("rejects non-GET methods", async () => {
    const response = await handler(adminEvent("platform-admin", "DELETE"));

    expect(response.statusCode).toBe(405);
  });

  test("returns the full roster and locations without requiring membership", async () => {
    routeByTable(sendMock, {
      // Inactive organizations are still visible to platform admins.
      organizations: () => ({
        Item: { organizationId: "org-1", name: "Org", status: "INACTIVE" },
      }),
      users: () => ({
        Item: { email: "a@example.com", givenName: "A", status: "ACTIVE" },
      }),
    });
    queryAllMock.mockImplementation(async (input: { TableName: string }) => {
      switch (input.TableName) {
        case "memberships":
          return [{ userId: "u1", role: "ADMIN", status: "ACTIVE" }];
        case "locations":
          return [{ organizationId: "org-1", locationId: "loc-1", name: "L" }];
        case "assignments":
          return [
            { organizationId: "org-1", locationId: "loc-1", status: "ACTIVE" },
          ];
        default:
          throw new Error(`Unexpected table: ${input.TableName}`);
      }
    });

    const response = await handler(adminEvent());
    const body = parseBody(response);

    expect(response.statusCode).toBe(200);
    expect(body.organization).toMatchObject({ status: "INACTIVE" });
    expect(body.users).toHaveLength(1);
    expect(body.locations[0].assignedUsers).toHaveLength(1);

    // The caller's own membership is never looked up.
    const tables = sendMock.mock.calls.map(
      ([command]) =>
        (command as { input: { TableName: string } }).input.TableName,
    );
    expect(tables).not.toContain("memberships");
  });
});
