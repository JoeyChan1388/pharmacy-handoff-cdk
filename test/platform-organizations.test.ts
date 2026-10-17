import { jest } from "@jest/globals";
import {
  type AnyMock,
  conditionalCheckFailed,
  makeEvent,
  parseBody,
  routeByCommand,
  routeByTable,
  sentCommands,
} from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
  scanAll: jest.fn(),
}));
jest.mock("@aws-sdk/client-cognito-identity-provider", () => {
  const send = jest.fn();
  return {
    ...jest.requireActual<object>("@aws-sdk/client-cognito-identity-provider"),
    CognitoIdentityProviderClient: class {
      send = send;
    },
  };
});

process.env.PLATFORM_ADMIN_USER_IDS = "platform-admin";

import { dynamodb, scanAll } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/platform/manageOrganizationsResolver";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

const sendMock = dynamodb.send as unknown as AnyMock;
const scanAllMock = scanAll as unknown as AnyMock;
const cognitoMock = new CognitoIdentityProviderClient({})
  .send as unknown as AnyMock;

function adminEvent(
  httpMethod: string,
  body?: Record<string, unknown>,
  organizationId?: string,
) {
  return makeEvent({
    sub: "platform-admin",
    httpMethod,
    body: body ? JSON.stringify(body) : null,
    pathParameters: organizationId ? { organizationId } : null,
  });
}

describe("platform organizations resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.USERS_TABLE_NAME = "users";
    process.env.STAFF_USER_POOL_ID = "staff-pool";
    process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME = "memberships";
    process.env.ORGANIZATIONS_TABLE_NAME = "organizations";
  });

  test("rejects callers outside the platform admin allowlist", async () => {
    const result = await handler(makeEvent({ sub: "someone-else" }));

    expect(result.statusCode).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("lists all organizations", async () => {
    scanAllMock.mockResolvedValue([{ organizationId: "org-1" }]);

    const result = await handler(adminEvent("GET"));

    expect(result.statusCode).toBe(200);
    expect(parseBody(result).organizations).toEqual([
      { organizationId: "org-1" },
    ]);
    expect(scanAllMock).toHaveBeenCalledWith("organizations");
  });

  test("creates an organization and its admin in one transaction", async () => {
    routeByCommand(cognitoMock, {
      AdminCreateUserCommand: () => ({
        User: {
          Attributes: [{ Name: "sub", Value: "admin-1" }],
          UserStatus: "FORCE_CHANGE_PASSWORD",
        },
      }),
    });
    sendMock.mockResolvedValue({});

    const result = await handler(
      adminEvent("POST", {
        organizationName: " New Org ",
        adminEmail: "Admin@Example.com",
      }),
    );
    const body = parseBody(result);

    expect(result.statusCode).toBe(201);
    expect(body.organization.name).toBe("New Org");
    expect(body.admin).toEqual({
      userId: "admin-1",
      email: "admin@example.com",
      role: "ADMIN",
      status: "INVITED",
    });
    const [transaction] = sentCommands(sendMock, "TransactWriteCommand");
    expect(transaction.input.TransactItems).toHaveLength(3);
  });

  test("removes the Cognito admin when the transaction fails", async () => {
    routeByCommand(cognitoMock, {
      AdminCreateUserCommand: () => ({
        User: { Attributes: [{ Name: "sub", Value: "admin-1" }] },
      }),
      AdminDeleteUserCommand: () => ({}),
    });
    sendMock.mockRejectedValue(new Error("DynamoDB is down"));

    await expect(
      handler(
        adminEvent("POST", {
          organizationName: "Org",
          adminEmail: "a@example.com",
        }),
      ),
    ).rejects.toThrow("DynamoDB is down");

    const [cleanup] = sentCommands(cognitoMock, "AdminDeleteUserCommand");
    expect(cleanup.input).toEqual({
      UserPoolId: "staff-pool",
      Username: "a@example.com",
    });
  });

  test("rejects an invalid status on update", async () => {
    const result = await handler(
      adminEvent("PATCH", { status: "DELETED" }, "org-1"),
    );

    expect(result.statusCode).toBe(400);
    expect(parseBody(result).message).toBe("status must be ACTIVE or INACTIVE");
    expect(sendMock).not.toHaveBeenCalled();
  });

  test("soft-deletes an organization and reports missing ones", async () => {
    routeByTable(sendMock, {
      organizations: (command) =>
        command.input.Key.organizationId === "org-1"
          ? { Attributes: { organizationId: "org-1", status: "INACTIVE" } }
          : (() => {
              throw conditionalCheckFailed();
            })(),
    });

    const deleted = await handler(adminEvent("DELETE", undefined, "org-1"));
    const missing = await handler(adminEvent("DELETE", undefined, "nope"));

    expect(deleted.statusCode).toBe(200);
    expect(parseBody(deleted).organization.status).toBe("INACTIVE");
    const [update] = sentCommands(sendMock, "UpdateCommand");
    expect(update.input.ExpressionAttributeValues[":status"]).toBe("INACTIVE");
    expect(missing.statusCode).toBe(404);
  });
});
