import { jest } from "@jest/globals";
import { type AnyMock, conditionalCheckFailed, sentCommands } from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
  queryAll: jest.fn(),
}));

import { dynamodb, queryAll } from "../lambda/shared/dynamodb";
import { handler } from "../lambda/auth/activateInvitedUserResolver";

import type { PostAuthenticationTriggerEvent } from "aws-lambda";

const sendMock = dynamodb.send as unknown as AnyMock;
const queryAllMock = queryAll as unknown as AnyMock;

const event = (sub?: string) =>
  ({
    triggerSource: "PostAuthentication_Authentication",
    request: { userAttributes: sub ? { sub } : {} },
  }) as unknown as PostAuthenticationTriggerEvent;

describe("ActivateInvitedUserResolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendMock.mockResolvedValue({});
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

  test("does nothing without a user sub", async () => {
    const input = event();

    await expect(handler(input)).resolves.toBe(input);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
