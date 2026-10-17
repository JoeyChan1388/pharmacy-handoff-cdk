import { jest } from "@jest/globals";

import type { APIGatewayProxyEvent } from "aws-lambda";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
  queryAll: jest.fn(),
}));

import { dynamodb, queryAll } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/organizations/manageOrganizationDetailsResolver";

const sendMock = dynamodb.send as unknown as jest.Mock<any>;
const queryAllMock = queryAll as unknown as jest.Mock<any>;

function makeEvent(
  overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: "GET",
    headers: {},
    pathParameters: { organizationId: "org-1" },
    requestContext: { authorizer: { claims: { sub: "staff-1" } } },
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function mockMembershipAndOrganization(role: "ADMIN" | "STAFF") {
  sendMock
    .mockImplementationOnce(async () => ({
      Item: { role, status: "ACTIVE", email: "user@example.com" },
    }))
    .mockImplementationOnce(async () => ({
      Item: { organizationId: "org-1", name: "Example Org", status: "ACTIVE" },
    }));
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
    sendMock.mockImplementation(
      async (command: {
        input: { TableName: string; Key?: Record<string, string> };
      }) => {
        switch (command.input.TableName) {
          case "memberships":
            return {
              Item: {
                role: "STAFF",
                status: "ACTIVE",
                email: "staff@example.com",
              },
            };
          case "organizations":
            return {
              Item: {
                organizationId: "org-1",
                name: "Example Org",
                status: "ACTIVE",
              },
            };
          case "users":
            return {
              Item: {
                userId: "staff-1",
                email: "staff@example.com",
                status: "ACTIVE",
              },
            };
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
      },
    );
    queryAllMock.mockImplementation(async (input: { TableName: string }) => {
      if (input.TableName !== "assignments") {
        throw new Error(`Staff should not read ${input.TableName}`);
      }
      return [
        { organizationId: "org-1", locationId: "location-1", status: "ACTIVE" },
        {
          organizationId: "org-1",
          locationId: "location-2",
          status: "INACTIVE",
        },
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

describe("PATCH organization details", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ORGANIZATIONS_TABLE_NAME = "organizations";
    process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME = "memberships";
    process.env.USERS_TABLE_NAME = "users";
    process.env.LOCATIONS_TABLE_NAME = "locations";
    process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME = "assignments";
  });

  test("lets an organization admin rename the organization", async () => {
    mockMembershipAndOrganization("ADMIN");
    sendMock.mockImplementationOnce(
      async (command: { input: Record<string, unknown> }) => ({
        Attributes: {
          organizationId: "org-1",
          name: (
            command.input.ExpressionAttributeValues as Record<string, string>
          )[":name"],
          status: "ACTIVE",
        },
      }),
    );

    const result = await handler(
      makeEvent({
        httpMethod: "PATCH",
        body: JSON.stringify({ name: "  New Name " }),
      }),
    );
    const body = JSON.parse(result.body ?? "{}");

    expect(result.statusCode).toBe(200);
    expect(body.organization.name).toBe("New Name");
    const updateInput = (
      sendMock.mock.calls[2][0] as { input: Record<string, unknown> }
    ).input;
    expect(updateInput.TableName).toBe("organizations");
    expect(updateInput.UpdateExpression).toBe(
      "SET #updatedAt = :updatedAt, #name = :name",
    );
    expect(queryAllMock).not.toHaveBeenCalled();
  });

  test("lets an organization admin soft-delete the organization", async () => {
    mockMembershipAndOrganization("ADMIN");
    sendMock.mockImplementationOnce(async () => ({
      Attributes: {
        organizationId: "org-1",
        name: "Example Org",
        status: "INACTIVE",
      },
    }));

    const result = await handler(makeEvent({ httpMethod: "DELETE" }));
    const body = JSON.parse(result.body ?? "{}");

    expect(result.statusCode).toBe(200);
    expect(body.organization.status).toBe("INACTIVE");
    const updateInput = (
      sendMock.mock.calls[2][0] as { input: Record<string, unknown> }
    ).input;
    expect(updateInput.UpdateExpression).toBe(
      "SET #updatedAt = :updatedAt, #status = :status",
    );
    expect(
      (updateInput.ExpressionAttributeValues as Record<string, string>)[
        ":status"
      ],
    ).toBe("INACTIVE");
  });

  test("rejects a regular staff member deleting the organization", async () => {
    mockMembershipAndOrganization("STAFF");

    const result = await handler(makeEvent({ httpMethod: "DELETE" }));

    expect(result.statusCode).toBe(403);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  test("rejects a regular staff member", async () => {
    mockMembershipAndOrganization("STAFF");

    const result = await handler(
      makeEvent({
        httpMethod: "PATCH",
        body: JSON.stringify({ name: "New Name" }),
      }),
    );

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body ?? "{}").message).toBe(
      "Organization admin access required",
    );
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  test("rejects an invalid name", async () => {
    mockMembershipAndOrganization("ADMIN");

    const result = await handler(
      makeEvent({ httpMethod: "PATCH", body: JSON.stringify({ name: "" }) }),
    );

    expect(result.statusCode).toBe(400);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
