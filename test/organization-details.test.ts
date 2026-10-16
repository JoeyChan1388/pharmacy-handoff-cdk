import { jest } from "@jest/globals";
import type { APIGatewayProxyEvent } from "aws-lambda";

jest.mock("../lambda/shared/dynamodb", () => ({
  dynamodb: { send: jest.fn() },
  queryAll: jest.fn(),
}));

import { dynamodb, queryAll } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/organizations/getOrganizationDetailsResolver";

const sendMock = dynamodb.send as unknown as jest.Mock<any>;
const queryAllMock = queryAll as unknown as jest.Mock<any>;

function makeEvent(): APIGatewayProxyEvent {
  return {
    httpMethod: "GET",
    headers: {},
    pathParameters: { organizationId: "org-1" },
    requestContext: { authorizer: { claims: { sub: "staff-1" } } },
  } as unknown as APIGatewayProxyEvent;
}

describe("GET organization details", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ORGANIZATIONS_TABLE_NAME = "organizations";
    process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME = "memberships";
    process.env.USERS_TABLE_NAME = "users";
    process.env.LOCATIONS_TABLE_NAME = "locations";
    process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME = "assignments";
  });

  test("allows active staff and limits their response to their assignments", async () => {
    sendMock.mockImplementation(async (command: { input: { TableName: string; Key?: Record<string, string> } }) => {
      switch (command.input.TableName) {
        case "memberships":
          return { Item: { role: "STAFF", status: "ACTIVE", email: "staff@example.com" } };
        case "organizations":
          return { Item: { organizationId: "org-1", name: "Example Org", status: "ACTIVE" } };
        case "users":
          return { Item: { userId: "staff-1", email: "staff@example.com", status: "ACTIVE" } };
        case "locations":
          return {
            Item: {
              organizationId: "org-1",
              locationId: command.input.Key?.locationId,
              name: "Assigned Location",
            },
          };
        default:
          throw new Error(`Unexpected table: ${command.input.TableName}`);
      }
    });
    queryAllMock.mockImplementation(async (input: { TableName: string }) => {
      if (input.TableName !== "assignments") {
        throw new Error(`Staff should not read ${input.TableName}`);
      }
      return [
        { organizationId: "org-1", locationId: "location-1", status: "ACTIVE" },
        { organizationId: "org-1", locationId: "location-2", status: "INACTIVE" },
        { organizationId: "org-2", locationId: "location-3", status: "ACTIVE" },
      ];
    });

    const result = await handler(makeEvent());
    const body = JSON.parse(result.body ?? "{}");

    expect(result.statusCode).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      userId: "staff-1",
      role: "STAFF",
      status: "ACTIVE",
      locationIds: ["location-1"],
    });
    expect(body.locations).toHaveLength(1);
    expect(body.locations[0].locationId).toBe("location-1");
    expect(body.locations[0].assignedUsers).toEqual([
      expect.objectContaining({ userId: "staff-1", role: "STAFF" }),
    ]);
    expect(queryAllMock).toHaveBeenCalledTimes(1);
  });

  test("rejects an inactive organization membership", async () => {
    sendMock.mockImplementationOnce(async () => ({
      Item: { role: "STAFF", status: "INVITED" },
    }));

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body ?? "{}").message).toBe(
      "Active organization membership required",
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(queryAllMock).not.toHaveBeenCalled();
  });
});
