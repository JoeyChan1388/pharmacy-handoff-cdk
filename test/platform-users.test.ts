import { jest } from "@jest/globals";
import {
  type AnyMock,
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

import { dynamodb } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/platform/manageUsersResolver";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

const sendMock = dynamodb.send as unknown as AnyMock;
const cognitoMock = new CognitoIdentityProviderClient({})
  .send as unknown as AnyMock;

function adminEvent(
  httpMethod: string,
  body?: Record<string, unknown>,
  userId?: string,
) {
  return makeEvent({
    sub: "platform-admin",
    httpMethod,
    body: body ? JSON.stringify(body) : null,
    pathParameters: userId ? { userId } : null,
  });
}

function mockExistingStaffUser() {
  routeByTable(sendMock, {
    users: (command) =>
      command.constructor.name === "GetCommand"
        ? { Item: { userId: "user-1", userPoolType: "STAFF" } }
        : {
            Attributes: {
              userId: "user-1",
              ...command.input.ExpressionAttributeValues,
            },
          },
  });
  routeByCommand(cognitoMock, {
    ListUsersCommand: () => ({ Users: [{ Username: "user-1@example.com" }] }),
    AdminUpdateUserAttributesCommand: () => ({}),
    AdminDisableUserCommand: () => ({}),
    AdminEnableUserCommand: () => ({}),
  });
}

describe("platform users resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.USERS_TABLE_NAME = "users";
    process.env.STAFF_USER_POOL_ID = "staff-pool";
    process.env.PATIENT_USER_POOL_ID = "patient-pool";
  });

  test("requires a valid user pool type on create", async () => {
    const result = await handler(
      adminEvent("POST", { email: "a@example.com", userPoolType: "ADMIN" }),
    );

    expect(result.statusCode).toBe(400);
    expect(parseBody(result).message).toBe(
      "userPoolType must be STAFF or PATIENT",
    );
  });

  test("creates a Cognito account and an invited profile", async () => {
    routeByCommand(cognitoMock, {
      AdminCreateUserCommand: () => ({
        User: {
          Username: "p@example.com",
          Attributes: [{ Name: "sub", Value: "patient-1" }],
        },
      }),
    });
    sendMock.mockResolvedValue({});

    const result = await handler(
      adminEvent("POST", {
        email: "P@Example.com",
        userPoolType: "PATIENT",
        givenName: " Pat ",
      }),
    );
    const { user } = parseBody(result);

    expect(result.statusCode).toBe(201);
    expect(user).toMatchObject({
      userId: "patient-1",
      email: "p@example.com",
      givenName: "Pat",
      userPoolType: "PATIENT",
      status: "INVITED",
    });
    const [create] = sentCommands(cognitoMock, "AdminCreateUserCommand");
    expect(create.input.UserPoolId).toBe("patient-pool");
    expect(create.input.UserAttributes).toEqual([
      { Name: "email", Value: "p@example.com" },
      { Name: "given_name", Value: "Pat" },
    ]);
    expect(sentCommands(sendMock, "PutCommand")).toHaveLength(1);
  });

  test("updates Cognito attributes and the profile together", async () => {
    mockExistingStaffUser();

    const result = await handler(
      adminEvent("PATCH", { familyName: "Chan" }, "user-1"),
    );

    expect(result.statusCode).toBe(200);
    const [attributes] = sentCommands(
      cognitoMock,
      "AdminUpdateUserAttributesCommand",
    );
    expect(attributes.input).toMatchObject({
      UserPoolId: "staff-pool",
      Username: "user-1@example.com",
      UserAttributes: [{ Name: "family_name", Value: "Chan" }],
    });
    const [update] = sentCommands(sendMock, "UpdateCommand");
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ":familyName": "Chan",
      ":userPoolType": "STAFF",
    });
  });

  test("disables the account and profile on delete", async () => {
    mockExistingStaffUser();

    const result = await handler(adminEvent("DELETE", undefined, "user-1"));

    expect(result.statusCode).toBe(200);
    expect(sentCommands(cognitoMock, "AdminDisableUserCommand")).toHaveLength(
      1,
    );
    expect(
      sentCommands(cognitoMock, "AdminUpdateUserAttributesCommand"),
    ).toHaveLength(0);
    const [update] = sentCommands(sendMock, "UpdateCommand");
    expect(update.input.ExpressionAttributeValues[":status"]).toBe("DISABLED");
  });

  test("reports a profile whose Cognito account is gone", async () => {
    routeByTable(sendMock, {
      users: () => ({ Item: { userId: "user-1", userPoolType: "STAFF" } }),
    });
    routeByCommand(cognitoMock, { ListUsersCommand: () => ({ Users: [] }) });

    const result = await handler(
      adminEvent("PATCH", { email: "x@example.com" }, "user-1"),
    );

    expect(result.statusCode).toBe(409);
    expect(sentCommands(sendMock, "UpdateCommand")).toHaveLength(0);
  });

  test("returns 404 for an unknown user", async () => {
    routeByTable(sendMock, { users: () => ({}) });

    const result = await handler(adminEvent("GET", undefined, "ghost"));

    expect(result.statusCode).toBe(404);
  });
});
