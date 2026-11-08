import { jest } from "@jest/globals";
import { type AnyMock, conditionalCheckFailed, sentCommands } from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
  queryAll: jest.fn(),
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

import { dynamodb, queryAll } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/auth/activateInvitedUserResolver";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

import type { PostAuthenticationTriggerEvent } from "aws-lambda";

const sendMock = dynamodb.send as unknown as AnyMock;
const queryAllMock = queryAll as unknown as AnyMock;
const cognitoMock = new CognitoIdentityProviderClient({})
  .send as unknown as AnyMock;

const event = (sub?: string, emailVerified = "true") =>
  ({
    triggerSource: "PostAuthentication_Authentication",
    userPoolId: "pool-1",
    userName: "uname",
    request: {
      userAttributes: sub ? { sub, email_verified: emailVerified } : {},
    },
  }) as unknown as PostAuthenticationTriggerEvent;

describe("ActivateInvitedUserResolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendMock.mockResolvedValue({});
    cognitoMock.mockResolvedValue({});
    process.env.USERS_TABLE_NAME = "users";
    process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME = "memberships";
    process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME = "assignments";
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  test("activates the profile and only INVITED memberships and assignments", async () => {
    queryAllMock.mockImplementation(async (input: { TableName: string }) =>
      input.TableName === "memberships"
        ? [
            { organizationId: "org-1", userId: "u1", status: "INVITED" },
            { organizationId: "org-2", userId: "u1", status: "ACTIVE" },
          ]
        : [
            { locationId: "loc-1", status: "INVITED" },
            { locationId: "loc-2", status: "ACTIVE" },
          ],
    );

    const input = event("u1");
    const result = await handler(input);

    expect(result).toBe(input);
    const updates = sentCommands(sendMock, "UpdateCommand").map((c) => ({
      table: c.input.TableName,
      key: c.input.Key,
      condition: c.input.ConditionExpression,
    }));
    expect(updates).toEqual(
      expect.arrayContaining([
        {
          table: "users",
          key: { userId: "u1" },
          condition: "#status = :invited",
        },
        {
          table: "memberships",
          key: { organizationId: "org-1", userId: "u1" },
          condition: "#status = :invited",
        },
        {
          table: "assignments",
          key: { userId: "u1", locationId: "loc-1" },
          condition: "#status = :invited",
        },
      ]),
    );
    expect(updates).toHaveLength(3);
  });

  test("ignores records that are no longer INVITED", async () => {
    queryAllMock.mockResolvedValue([]);
    sendMock.mockRejectedValue(conditionalCheckFailed());

    const input = event("u1");

    await expect(handler(input)).resolves.toBe(input);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("never blocks login when activation fails", async () => {
    queryAllMock.mockRejectedValue(new Error("dynamo down"));

    const input = event("u1");

    await expect(handler(input)).resolves.toBe(input);
    expect(console.error).toHaveBeenCalled();
  });

  describe("email verification", () => {
    beforeEach(() => queryAllMock.mockResolvedValue([]));

    test("marks an unverified email verified so password reset works", async () => {
      await handler(event("u1", "false"));

      expect(cognitoMock).toHaveBeenCalledTimes(1);
      const [command] = cognitoMock.mock.calls[0] as [{ input: unknown }];
      expect(command.input).toEqual({
        UserPoolId: "pool-1",
        Username: "uname",
        UserAttributes: [{ Name: "email_verified", Value: "true" }],
      });
    });

    test("does not call Cognito when the email is already verified", async () => {
      await handler(event("u1", "true"));

      expect(cognitoMock).not.toHaveBeenCalled();
    });

    test("a verification failure neither blocks login nor skips activation", async () => {
      cognitoMock.mockRejectedValue(new Error("cognito down"));
      const input = event("u1", "false");

      await expect(handler(input)).resolves.toBe(input);
      expect(console.error).toHaveBeenCalled();
      // The table updates still ran.
      expect(sentCommands(sendMock, "UpdateCommand").length).toBeGreaterThan(0);
    });
  });

  test("does nothing without a user sub", async () => {
    const input = event();

    await expect(handler(input)).resolves.toBe(input);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
