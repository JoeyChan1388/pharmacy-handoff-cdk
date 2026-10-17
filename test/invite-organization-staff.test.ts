import { jest } from "@jest/globals";
import {
  type AnyMock,
  awsError,
  makeEvent,
  parseBody,
  routeByCommand,
  routeByTable,
  type SendHandler,
  sentCommands,
} from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
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

import { dynamodb } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/organizations/inviteOrganizationStaffResolver";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

const sendMock = dynamodb.send as unknown as AnyMock;
const cognitoMock = new CognitoIdentityProviderClient({})
  .send as unknown as AnyMock;

const SUB_ATTRIBUTE = { Name: "sub", Value: "invitee-1" };

function invite(body: Record<string, unknown>) {
  return makeEvent({
    httpMethod: "POST",
    body: JSON.stringify(body),
    pathParameters: { organizationId: "org-1" },
  });
}

function mockTables(overrides: Record<string, SendHandler> = {}) {
  routeByTable(sendMock, {
    memberships: (command) =>
      command.constructor.name === "GetCommand" &&
      command.input.Key.userId === "staff-1"
        ? { Item: { role: "ADMIN", status: "ACTIVE" } }
        : {},
    organizations: () => ({
      Item: { organizationId: "org-1", status: "ACTIVE" },
    }),
    locations: () => ({ Item: { locationId: "loc-1" } }),
    users: () => ({}),
    assignments: () => ({}),
    ...overrides,
  });
}

describe("invite organization staff resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.USERS_TABLE_NAME = "users";
    process.env.ORGANIZATIONS_TABLE_NAME = "organizations";
    process.env.LOCATIONS_TABLE_NAME = "locations";
    process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME = "assignments";
    process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME = "memberships";
    process.env.STAFF_USER_POOL_ID = "staff-pool";
  });

  test("invites an existing confirmed Cognito user as active staff", async () => {
    mockTables();
    routeByCommand(cognitoMock, {
      AdminGetUserCommand: () => ({
        UserAttributes: [SUB_ATTRIBUTE],
        UserStatus: "CONFIRMED",
      }),
    });

    const result = await handler(
      invite({ email: " Invitee@Example.com ", locationIds: ["loc-1"] }),
    );

    expect(result.statusCode).toBe(201);
    expect(parseBody(result)).toMatchObject({
      userId: "invitee-1",
      email: "invitee@example.com",
      organizationId: "org-1",
      role: "STAFF",
      status: "ACTIVE",
      locationIds: ["loc-1"],
    });
    const updates = sentCommands(sendMock, "UpdateCommand");
    expect(updates.map((command) => command.input.TableName)).toEqual([
      "users",
      "memberships",
      "assignments",
    ]);
    expect(sentCommands(cognitoMock, "AdminCreateUserCommand")).toHaveLength(0);
  });

  test("creates the Cognito user when none exists and marks them invited", async () => {
    mockTables();
    routeByCommand(cognitoMock, {
      AdminGetUserCommand: () => {
        throw awsError("UserNotFoundException");
      },
      AdminCreateUserCommand: () => ({
        User: {
          Attributes: [SUB_ATTRIBUTE],
          UserStatus: "FORCE_CHANGE_PASSWORD",
        },
      }),
    });

    const result = await handler(
      invite({ email: "new@example.com", locationIds: ["loc-1"] }),
    );

    expect(result.statusCode).toBe(201);
    expect(parseBody(result).status).toBe("INVITED");
    const [create] = sentCommands(cognitoMock, "AdminCreateUserCommand");
    expect(create.input).toMatchObject({
      UserPoolId: "staff-pool",
      Username: "new@example.com",
      DesiredDeliveryMediums: ["EMAIL"],
    });
  });

  test("rejects locations that belong to another organization", async () => {
    mockTables({ locations: () => ({}) });

    const result = await handler(
      invite({ email: "new@example.com", locationIds: ["other-loc"] }),
    );

    expect(result.statusCode).toBe(400);
    expect(parseBody(result).message).toBe(
      "Every location must belong to the requested organization",
    );
    expect(cognitoMock).not.toHaveBeenCalled();
  });

  test("rejects duplicate location IDs", async () => {
    mockTables();

    const result = await handler(
      invite({ email: "new@example.com", locationIds: ["loc-1", " loc-1 "] }),
    );

    expect(result.statusCode).toBe(400);
    expect(parseBody(result).message).toBe(
      "locationIds must not contain duplicates",
    );
  });

  test("refuses to downgrade an existing organization admin", async () => {
    mockTables({
      memberships: () => ({ Item: { role: "ADMIN", status: "ACTIVE" } }),
    });
    routeByCommand(cognitoMock, {
      AdminGetUserCommand: () => ({
        UserAttributes: [SUB_ATTRIBUTE],
        UserStatus: "CONFIRMED",
      }),
    });

    const result = await handler(
      invite({ email: "admin@example.com", locationIds: ["loc-1"] }),
    );

    expect(result.statusCode).toBe(409);
    expect(sentCommands(sendMock, "UpdateCommand")).toHaveLength(0);
  });
});
