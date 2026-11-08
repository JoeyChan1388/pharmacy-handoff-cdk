import { jest } from "@jest/globals";
import {
  type AnyMock,
  makeEvent,
  parseBody,
  type SentCommand,
  sentCommands,
} from "./helpers";

jest.mock("../lambda/shared/dynamodb", () => ({
  ...jest.requireActual<object>("../lambda/shared/dynamodb"),
  dynamodb: { send: jest.fn() },
  queryAll: jest.fn(),
  batchGetAll: jest.fn(),
}));

import { handler } from "../lambda/messaging/messagingResolver";
import { batchGetAll, dynamodb, queryAll } from "../lambda/shared/dynamodb";

const sendMock = dynamodb.send as unknown as AnyMock;
const queryAllMock = queryAll as unknown as AnyMock;
const batchGetMock = batchGetAll as unknown as AnyMock;

function event(
  httpMethod: string,
  resource: string,
  extra: Record<string, unknown> = {},
  sub = "u1",
) {
  return makeEvent({
    sub,
    httpMethod,
    resource,
    ...extra,
  } as never);
}

/** Routes DynamoDB sends by table; transactions span tables, so they always succeed. */
function routeByTable(
  mock: AnyMock,
  handlers: Record<string, (command: SentCommand) => unknown>,
) {
  mock.mockImplementation(async (command: SentCommand) => {
    if (command.constructor.name === "TransactWriteCommand") return {};
    const handler = handlers[command.input.TableName as string];
    if (!handler)
      throw new Error(`Unexpected table: ${command.input.TableName}`);
    return handler(command);
  });
}

const post = (body: unknown) => JSON.stringify(body);

/** Active memberships for the listed users in org-1; everyone else is absent. */
function memberships(...activeIds: string[]) {
  return (command: SentCommand) => {
    const id = command.input.Key.userId as string;
    return activeIds.includes(id)
      ? { Item: { status: "ACTIVE", role: "STAFF" } }
      : {};
  };
}

describe("messaging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.USERS_TABLE_NAME = "users";
    process.env.MESSAGES_TABLE_NAME = "messages";
    process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME = "memberships";
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.CONVERSATION_MEMBERS_TABLE_NAME = "members";
  });

  describe("POST /staff/me/conversations", () => {
    const create = (body: unknown, sub = "u1") =>
      event("POST", "/staff/me/conversations", { body: post(body) }, sub);

    test("rejects participants who are not in the organization", async () => {
      routeByTable(sendMock, { memberships: memberships("u1") });

      const response = await handler(
        create({ organizationId: "org-1", memberIds: ["u2"], message: "hi" }),
      );

      expect(response.statusCode).toBe(400);
      expect(sentCommands(sendMock, "TransactWriteCommand")).toHaveLength(0);
    });

    test("rejects a caller who is not an active member", async () => {
      routeByTable(sendMock, { memberships: memberships("u2") });

      const response = await handler(
        create({ organizationId: "org-1", memberIds: ["u2"], message: "hi" }),
      );

      expect(response.statusCode).toBe(403);
    });

    test("validates the body", async () => {
      routeByTable(sendMock, { memberships: memberships("u1", "u2") });

      for (const body of [
        { organizationId: "org-1", memberIds: ["u2"], message: "  " },
        { organizationId: "org-1", memberIds: [], message: "hi" },
        { organizationId: "org-1", memberIds: ["u1"], message: "hi" },
        { memberIds: ["u2"], message: "hi" },
        { organizationId: "org-1", memberIds: "u2", message: "hi" },
      ]) {
        expect((await handler(create(body))).statusCode).toBe(400);
      }
    });

    test("creates a direct conversation with a deterministic id", async () => {
      routeByTable(sendMock, {
        memberships: memberships("u1", "u2"),
        conversations: () => ({}),
        members: () => ({}),
        messages: () => ({}),
      });

      const response = await handler(
        create({
          organizationId: "org-1",
          memberIds: ["u2"],
          message: " hello ",
        }),
      );
      const body = parseBody(response);

      expect(response.statusCode).toBe(201);
      expect(body.conversation).toMatchObject({
        conversationId: "direct:org-1:u1:u2",
        type: "DIRECT",
      });
      expect(body.message.body).toBe("hello");

      const [transaction] = sentCommands(sendMock, "TransactWriteCommand");
      const items = transaction.input.TransactItems;
      // conversation + 2 members + message
      expect(items).toHaveLength(4);
      const sender = items.find(
        (i: any) => i.Put.Item.userId === "u1" && i.Put.Item.lastReadAt,
      );
      const recipient = items.find((i: any) => i.Put.Item.userId === "u2");
      expect(sender).toBeDefined();
      expect(recipient.Put.Item.lastReadAt).toBeUndefined();
    });

    test("reuses an existing direct conversation instead of duplicating it", async () => {
      routeByTable(sendMock, {
        memberships: memberships("u1", "u2"),
        conversations: (command) =>
          command.constructor.name === "GetCommand"
            ? {
                Item: {
                  conversationId: "direct:org-1:u1:u2",
                  memberIds: ["u1", "u2"],
                },
              }
            : {},
      });

      const response = await handler(
        create({
          organizationId: "org-1",
          memberIds: ["u2"],
          message: "again",
        }),
      );

      expect(response.statusCode).toBe(200);
      const [transaction] = sentCommands(sendMock, "TransactWriteCommand");
      // message put + conversation update + 2 member updates; no conversation Put
      expect(transaction.input.TransactItems).toHaveLength(4);
      expect(
        transaction.input.TransactItems.some(
          (i: any) => i.Put?.TableName === "conversations",
        ),
      ).toBe(false);
    });

    test("creates a group with a title for several participants", async () => {
      routeByTable(sendMock, {
        memberships: memberships("u1", "u2", "u3"),
        members: () => ({}),
        messages: () => ({}),
        conversations: () => ({}),
      });

      const response = await handler(
        create({
          organizationId: "org-1",
          memberIds: ["u2", "u3", "u2"],
          title: "Evening shift",
          message: "hi all",
        }),
      );
      const body = parseBody(response);

      expect(response.statusCode).toBe(201);
      expect(body.conversation).toMatchObject({
        type: "GROUP",
        title: "Evening shift",
        memberIds: ["u1", "u2", "u3"],
      });
    });
  });

  describe("conversation access", () => {
    const messagesEvent = (method: string, sub = "u1", extra = {}) =>
      event(
        method,
        "/staff/me/conversations/{conversationId}/messages",
        { pathParameters: { conversationId: "c1" }, ...extra },
        sub,
      );

    test("hides conversations from non-participants as 404", async () => {
      routeByTable(sendMock, {
        members: () => ({}),
        conversations: () => ({
          Item: {
            conversationId: "c1",
            organizationId: "org-1",
            memberIds: ["u2"],
          },
        }),
      });

      const response = await handler(messagesEvent("GET", "intruder"));

      expect(response.statusCode).toBe(404);
    });

    test("blocks participants who left the organization", async () => {
      routeByTable(sendMock, {
        members: () => ({ Item: { userId: "u1" } }),
        conversations: () => ({
          Item: {
            conversationId: "c1",
            organizationId: "org-1",
            memberIds: ["u1"],
          },
        }),
        memberships: () => ({ Item: { status: "INACTIVE" } }),
      });

      const response = await handler(
        messagesEvent("POST", "u1", { body: post({ body: "x" }) }),
      );

      expect(response.statusCode).toBe(403);
    });

    test("returns messages oldest first and a cursor when more exist", async () => {
      routeByTable(sendMock, {
        members: () => ({ Item: { userId: "u1" } }),
        conversations: () => ({
          Item: {
            conversationId: "c1",
            organizationId: "org-1",
            memberIds: ["u1"],
          },
        }),
        memberships: memberships("u1"),
        messages: () => ({
          Items: [
            {
              messageId: "0002",
              senderId: "u1",
              body: "second",
              createdAt: "t2",
            },
            {
              messageId: "0001",
              senderId: "u2",
              body: "first",
              createdAt: "t1",
            },
          ],
          LastEvaluatedKey: { messageId: "0001" },
        }),
      });

      const response = await handler(messagesEvent("GET"));
      const body = parseBody(response);

      expect(body.messages.map((m: any) => m.body)).toEqual([
        "first",
        "second",
      ]);
      expect(body.nextBefore).toBe("0001");
      const [query] = sentCommands(sendMock, "QueryCommand");
      expect(query.input.ScanIndexForward).toBe(false);
    });

    test("posting updates every participant's inbox entry and marks the sender read", async () => {
      routeByTable(sendMock, {
        members: () => ({ Item: { userId: "u1" } }),
        conversations: () => ({
          Item: {
            conversationId: "c1",
            organizationId: "org-1",
            memberIds: ["u1", "u2"],
          },
        }),
        memberships: memberships("u1"),
      });

      const response = await handler(
        messagesEvent("POST", "u1", { body: post({ body: "yo" }) }),
      );

      expect(response.statusCode).toBe(201);
      const [transaction] = sentCommands(sendMock, "TransactWriteCommand");
      const updates = transaction.input.TransactItems.filter(
        (i: any) => i.Update?.TableName === "members",
      );
      expect(updates).toHaveLength(2);
      const byUser = Object.fromEntries(
        updates.map((i: any) => [
          i.Update.Key.userId,
          i.Update.UpdateExpression,
        ]),
      );
      expect(byUser.u1).toContain("lastReadAt");
      expect(byUser.u2).not.toContain("lastReadAt");
    });

    test("rejects an empty or oversized message", async () => {
      routeByTable(sendMock, {
        members: () => ({ Item: { userId: "u1" } }),
        conversations: () => ({
          Item: {
            conversationId: "c1",
            organizationId: "org-1",
            memberIds: ["u1"],
          },
        }),
        memberships: memberships("u1"),
      });

      for (const text of ["   ", "x".repeat(4001)]) {
        const response = await handler(
          messagesEvent("POST", "u1", { body: post({ body: text }) }),
        );
        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe("GET /staff/me/conversations", () => {
    test("returns newest first with participants and unread flags", async () => {
      queryAllMock.mockResolvedValue([
        {
          conversationId: "old",
          lastMessageAt: "2026-01-01",
          lastMessagePreview: "a",
          lastMessageSenderId: "u2",
          lastReadAt: "2026-01-02",
        },
        {
          conversationId: "new",
          lastMessageAt: "2026-03-01",
          lastMessagePreview: "b",
          lastMessageSenderId: "u2",
        },
        {
          conversationId: "mine",
          lastMessageAt: "2026-02-01",
          lastMessagePreview: "c",
          lastMessageSenderId: "u1",
        },
      ]);
      batchGetMock.mockImplementation(async (table: string) =>
        table === "conversations"
          ? ["old", "new", "mine"].map((id) => ({
              conversationId: id,
              organizationId: "org-1",
              type: "DIRECT",
              memberIds: ["u1", "u2"],
            }))
          : [
              { userId: "u1", email: "me@x.com" },
              { userId: "u2", email: "you@x.com", givenName: "You" },
            ],
      );

      const response = await handler(event("GET", "/staff/me/conversations"));
      const { conversations } = parseBody(response);

      expect(conversations.map((c: any) => c.conversationId)).toEqual([
        "new",
        "mine",
        "old",
      ]);
      expect(conversations.map((c: any) => c.unread)).toEqual([
        true,
        false,
        false,
      ]);
      expect(conversations[0].participants).toHaveLength(2);
    });
  });

  describe("POST /staff/me/conversations/{id}/read", () => {
    test("404s when the caller is not a participant", async () => {
      const error = new Error("x");
      error.name = "ConditionalCheckFailedException";
      sendMock.mockRejectedValue(error);

      const response = await handler(
        event("POST", "/staff/me/conversations/{conversationId}/read", {
          pathParameters: { conversationId: "c1" },
        }),
      );

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /organizations/{organizationId}/colleagues", () => {
    const colleagues = (sub = "u1") =>
      event(
        "GET",
        "/organizations/{organizationId}/colleagues",
        {
          pathParameters: { organizationId: "org-1" },
        },
        sub,
      );

    test("requires active membership", async () => {
      routeByTable(sendMock, { memberships: memberships() });

      expect((await handler(colleagues())).statusCode).toBe(403);
    });

    test("lists other active members only", async () => {
      routeByTable(sendMock, { memberships: memberships("u1") });
      queryAllMock.mockResolvedValue([
        { userId: "u1", status: "ACTIVE", role: "ADMIN" },
        { userId: "u2", status: "ACTIVE", role: "STAFF" },
        { userId: "u3", status: "INVITED", role: "STAFF" },
      ]);
      batchGetMock.mockResolvedValue([
        { userId: "u2", email: "u2@x.com", givenName: "Two" },
      ]);

      const { colleagues: list } = parseBody(await handler(colleagues()));

      expect(list).toEqual([
        {
          userId: "u2",
          role: "STAFF",
          email: "u2@x.com",
          givenName: "Two",
          familyName: undefined,
        },
      ]);
    });
  });

  test("returns 401 without a caller", async () => {
    const response = await handler(
      makeEvent({
        httpMethod: "GET",
        resource: "/staff/me/conversations",
        requestContext: {},
      } as never),
    );

    expect(response.statusCode).toBe(401);
  });
});
