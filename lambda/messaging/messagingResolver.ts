import { jsonResponse } from "../shared/http";
import { getCallerUserId } from "../shared/authorization";
import {
  optionalText,
  parseJsonBody,
  requiredText,
} from "../shared/validation";
import {
  batchGetAll,
  dynamodb,
  isConditionalCheckFailed,
  queryAll,
} from "../shared/dynamodb";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CONVERSATION_MAX_MEMBERS,
  getActiveMembership,
  loadProfiles,
  MESSAGE_MAX_LENGTH,
  newSortableId,
  previewOf,
  type PublicProfile,
} from "../shared/messaging";

import type { OrganizationMembership } from "../shared/types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * Config
 *
 * Table names the resolver reads from the environment.
 */
interface Config {
  usersTable: string;
  messagesTable: string;
  membershipsTable: string;
  conversationsTable: string;
  conversationMembersTable: string;
}

/**
 * ConversationRecord
 *
 * A conversation as stored in the conversations table.
 */
interface ConversationRecord {
  title?: string;
  createdBy: string;
  createdAt: string;
  memberIds: string[];
  lastMessageAt: string;
  conversationId: string;
  organizationId: string;
  type: "DIRECT" | "GROUP";
  lastMessagePreview: string;
  lastMessageSenderId: string;
}

/**
 * ConversationMemberRecord
 *
 * A user's per-conversation inbox entry.
 */
interface ConversationMemberRecord {
  userId: string;
  lastReadAt?: string;
  lastMessageAt: string;
  conversationId: string;
  organizationId: string;
  lastMessagePreview: string;
  lastMessageSenderId: string;
}

/**
 * MessageRecord
 *
 * A message as stored in the messages table.
 */
interface MessageRecord {
  body: string;
  senderId: string;
  messageId: string;
  createdAt: string;
  conversationId: string;
}

/**
 * Number of messages returned per page.
 */
const MESSAGE_PAGE_SIZE = 50;

/**
 * Maximum conversations returned by the inbox listing.
 */
const INBOX_LIMIT = 100;

/**
 * Maximum length of a group conversation title.
 */
const TITLE_MAX_LENGTH = 100;

/**
 * Reads the required table names from the environment, throwing when any
 * value is missing so the deployment error surfaces immediately.
 *
 * @returns The resolved configuration
 */
function loadConfig(): Config {
  const config = {
    usersTable: process.env.USERS_TABLE_NAME,
    messagesTable: process.env.MESSAGES_TABLE_NAME,
    membershipsTable: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
    conversationsTable: process.env.CONVERSATIONS_TABLE_NAME,
    conversationMembersTable: process.env.CONVERSATION_MEMBERS_TABLE_NAME,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error("Messaging Lambda is missing table configuration");
  }
  return config as Config;
}

/**
 * MessagingResolver Handler
 *
 * Single Lambda for staff messaging. Conversations are always scoped to one
 * organization: every participant must be an active member of it, and only
 * participants can read or write a conversation.
 *
 *  - GET  /staff/me/conversations
 *  - POST /staff/me/conversations
 *  - GET  /staff/me/conversations/{conversationId}/messages
 *  - POST /staff/me/conversations/{conversationId}/messages
 *  - POST /staff/me/conversations/{conversationId}/read
 *  - GET  /organizations/{organizationId}/colleagues
 *
 * @param event The API Gateway event
 * @returns The response for the matched route
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const userId = getCallerUserId(event);
  if (!userId) {
    return jsonResponse(event, 401, { message: "Unauthorized" });
  }

  const config = loadConfig();
  const conversationId = event.pathParameters?.conversationId;

  switch (`${event.httpMethod} ${event.resource}`) {
    case "GET /staff/me/conversations":
      return listConversations(event, config, userId);
    case "POST /staff/me/conversations":
      return createConversation(event, config, userId);
    case "GET /staff/me/conversations/{conversationId}/messages":
      return listMessages(event, config, userId, conversationId);
    case "POST /staff/me/conversations/{conversationId}/messages":
      return postMessage(event, config, userId, conversationId);
    case "POST /staff/me/conversations/{conversationId}/read":
      return markRead(event, config, userId, conversationId);
    case "GET /organizations/{organizationId}/colleagues":
      return listColleagues(
        event,
        config,
        userId,
        event.pathParameters?.organizationId,
      );
    default:
      return jsonResponse(event, 405, { message: "Method not allowed" });
  }
};

/**
 * List Conversations
 *
 * Returns the caller's conversations, newest activity first, each with its
 * participants and an unread flag.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param userId The caller
 * @returns A 200 response with the conversations
 */
async function listConversations(
  event: APIGatewayProxyEvent,
  config: Config,
  userId: string,
): Promise<APIGatewayProxyResult> {
  const entries = (
    await queryAll<ConversationMemberRecord>({
      TableName: config.conversationMembersTable,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId },
    })
  )
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    .slice(0, INBOX_LIMIT);

  const conversations = await batchGetAll<ConversationRecord>(
    config.conversationsTable,
    entries.map(({ conversationId }) => ({ conversationId })),
  );
  const byId = new Map(conversations.map((c) => [c.conversationId, c]));
  const profiles = await loadProfiles(
    config.usersTable,
    conversations.flatMap((c) => c.memberIds),
  );

  const result = entries.flatMap((entry) => {
    const conversation = byId.get(entry.conversationId);
    if (!conversation) return [];
    return [
      {
        conversationId: conversation.conversationId,
        organizationId: conversation.organizationId,
        type: conversation.type,
        title: conversation.title,
        participants: conversation.memberIds
          .map((id) => profiles.get(id))
          .filter((p): p is PublicProfile => p !== undefined),
        lastMessage: {
          preview: entry.lastMessagePreview,
          senderId: entry.lastMessageSenderId,
          createdAt: entry.lastMessageAt,
        },
        unread:
          entry.lastMessageSenderId !== userId &&
          (!entry.lastReadAt || entry.lastReadAt < entry.lastMessageAt),
      },
    ];
  });

  return jsonResponse(event, 200, { conversations: result });
}

/**
 * Create Conversation
 *
 * Starts a conversation with the first message. One other participant makes a
 * direct conversation (reused if it already exists); several make a group.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param userId The caller
 * @returns A 201 response with the new conversation, a 200 when an existing
 * direct conversation received the message, or a 4xx error
 */
async function createConversation(
  event: APIGatewayProxyEvent,
  config: Config,
  userId: string,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody<{
    title?: unknown;
    message?: unknown;
    memberIds?: unknown;
    organizationId?: unknown;
  }>(event);
  if (!body) {
    return jsonResponse(event, 400, {
      message: "Request body must be valid JSON",
    });
  }

  const { organizationId } = body;
  const message = requiredText(body.message, MESSAGE_MAX_LENGTH);
  if (typeof organizationId !== "string" || !organizationId) {
    return jsonResponse(event, 400, { message: "organizationId is required" });
  }
  if (!message) {
    return jsonResponse(event, 400, {
      message: `message is required and must be at most ${MESSAGE_MAX_LENGTH} characters`,
    });
  }
  if (
    !Array.isArray(body.memberIds) ||
    body.memberIds.some((id) => typeof id !== "string")
  ) {
    return jsonResponse(event, 400, {
      message: "memberIds must be an array of user IDs",
    });
  }

  const others = [...new Set(body.memberIds as string[])].filter(
    (id) => id !== userId,
  );
  if (others.length < 1 || others.length > CONVERSATION_MAX_MEMBERS - 1) {
    return jsonResponse(event, 400, {
      message: `A conversation needs between 1 and ${CONVERSATION_MAX_MEMBERS - 1} other participants`,
    });
  }

  let title: string | undefined;
  try {
    title = optionalText(body.title, "title", TITLE_MAX_LENGTH);
  } catch (error) {
    return jsonResponse(event, 400, { message: (error as Error).message });
  }

  /**
   * Organization Check
   *
   * The caller and every participant must be active members of the
   * organization, which keeps conversations from crossing organizations.
   */
  const memberIds = [userId, ...others];
  const memberships = await Promise.all(
    memberIds.map((id) =>
      getActiveMembership(config.membershipsTable, organizationId, id),
    ),
  );
  if (!memberships[0]) {
    return jsonResponse(event, 403, {
      message: "Active organization membership required",
    });
  }
  if (memberships.some((membership) => !membership)) {
    return jsonResponse(event, 400, {
      message: "All participants must be active members of the organization",
    });
  }

  const isDirect = others.length === 1;
  const conversationId = isDirect
    ? `direct:${organizationId}:${[...memberIds].sort().join(":")}`
    : newSortableId();

  if (isDirect) {
    const existing = await dynamodb.send(
      new GetCommand({
        TableName: config.conversationsTable,
        Key: { conversationId },
      }),
    );
    if (existing.Item) {
      return sendIntoConversation(
        event,
        config,
        existing.Item as ConversationRecord,
        userId,
        message,
        200,
      );
    }
  }

  const now = new Date().toISOString();
  const messageId = newSortableId();
  const preview = previewOf(message);
  const conversation: ConversationRecord = {
    conversationId,
    organizationId,
    type: isDirect ? "DIRECT" : "GROUP",
    ...(title && !isDirect ? { title } : {}),
    memberIds,
    createdBy: userId,
    createdAt: now,
    lastMessageAt: now,
    lastMessagePreview: preview,
    lastMessageSenderId: userId,
  };

  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: config.conversationsTable,
              Item: conversation,
              ConditionExpression: "attribute_not_exists(conversationId)",
            },
          },
          ...memberIds.map((id) => ({
            Put: {
              TableName: config.conversationMembersTable,
              Item: {
                userId: id,
                conversationId,
                organizationId,
                lastMessageAt: now,
                lastMessagePreview: preview,
                lastMessageSenderId: userId,
                ...(id === userId ? { lastReadAt: now } : {}),
              } satisfies ConversationMemberRecord,
            },
          })),
          {
            Put: {
              TableName: config.messagesTable,
              Item: {
                conversationId,
                messageId,
                senderId: userId,
                body: message,
                createdAt: now,
              } satisfies MessageRecord,
            },
          },
        ],
      }),
    );
  } catch (error) {
    // Two people starting the same direct chat at once: the loser's create
    // is cancelled by the existence condition, so deliver into the winner's.
    if (
      isDirect &&
      (error as { name?: string }).name === "TransactionCanceledException"
    ) {
      return sendIntoConversation(
        event,
        config,
        conversation,
        userId,
        message,
        200,
      );
    }
    throw error;
  }

  return jsonResponse(event, 201, {
    conversation: {
      conversationId,
      organizationId,
      type: conversation.type,
      title: conversation.title,
      memberIds,
    },
    message: { messageId, senderId: userId, body: message, createdAt: now },
  });
}

/**
 * Loads a conversation for a participant, enforcing that the caller is in it
 * and still an active member of its organization.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param userId The caller
 * @param conversationId The requested conversation
 * @returns The conversation, or an error response
 */
async function loadParticipantConversation(
  event: APIGatewayProxyEvent,
  config: Config,
  userId: string,
  conversationId: string | undefined,
): Promise<ConversationRecord | APIGatewayProxyResult> {
  if (!conversationId) {
    return jsonResponse(event, 400, { message: "conversationId is required" });
  }

  const [entry, conversation] = await Promise.all([
    dynamodb.send(
      new GetCommand({
        TableName: config.conversationMembersTable,
        Key: { userId, conversationId },
      }),
    ),
    dynamodb.send(
      new GetCommand({
        TableName: config.conversationsTable,
        Key: { conversationId },
      }),
    ),
  ]);

  // Not-a-participant looks the same as not-found so IDs cannot be probed.
  if (!entry.Item || !conversation.Item) {
    return jsonResponse(event, 404, { message: "Conversation not found" });
  }

  const record = conversation.Item as ConversationRecord;
  const membership = await getActiveMembership(
    config.membershipsTable,
    record.organizationId,
    userId,
  );
  if (!membership) {
    return jsonResponse(event, 403, {
      message: "Active organization membership required",
    });
  }
  return record;
}

/**
 * Type guard separating a loaded conversation from an error response.
 *
 * @param value The result of loadParticipantConversation
 * @returns True when the value is an error response
 */
function isErrorResponse(
  value: ConversationRecord | APIGatewayProxyResult,
): value is APIGatewayProxyResult {
  return "statusCode" in value;
}

/**
 * List Messages
 *
 * Returns up to 50 messages in chronological order. Pass `before` (a
 * messageId) to load the page of older messages.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param userId The caller
 * @param conversationId The conversation to read
 * @returns A 200 response with the messages and an optional older cursor
 */
async function listMessages(
  event: APIGatewayProxyEvent,
  config: Config,
  userId: string,
  conversationId: string | undefined,
): Promise<APIGatewayProxyResult> {
  const conversation = await loadParticipantConversation(
    event,
    config,
    userId,
    conversationId,
  );
  if (isErrorResponse(conversation)) return conversation;

  const before = event.queryStringParameters?.before;
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: config.messagesTable,
      KeyConditionExpression: before
        ? "conversationId = :conversationId AND messageId < :before"
        : "conversationId = :conversationId",
      ExpressionAttributeValues: {
        ":conversationId": conversation.conversationId,
        ...(before ? { ":before": before } : {}),
      },
      ScanIndexForward: false,
      Limit: MESSAGE_PAGE_SIZE,
    }),
  );

  const messages = ((result.Items ?? []) as MessageRecord[])
    .reverse()
    .map(({ messageId, senderId, body, createdAt }) => ({
      messageId,
      senderId,
      body,
      createdAt,
    }));

  return jsonResponse(event, 200, {
    messages,
    nextBefore: result.LastEvaluatedKey ? messages[0]?.messageId : undefined,
  });
}

/**
 * Post Message
 *
 * Adds a message to a conversation the caller participates in.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param userId The caller
 * @param conversationId The conversation to write to
 * @returns A 201 response with the message, or a 4xx error
 */
async function postMessage(
  event: APIGatewayProxyEvent,
  config: Config,
  userId: string,
  conversationId: string | undefined,
): Promise<APIGatewayProxyResult> {
  const conversation = await loadParticipantConversation(
    event,
    config,
    userId,
    conversationId,
  );
  if (isErrorResponse(conversation)) return conversation;

  const body = parseJsonBody<{ body?: unknown }>(event);
  const message = requiredText(body?.body, MESSAGE_MAX_LENGTH);
  if (!message) {
    return jsonResponse(event, 400, {
      message: `body is required and must be at most ${MESSAGE_MAX_LENGTH} characters`,
    });
  }

  return sendIntoConversation(
    event,
    config,
    conversation,
    userId,
    message,
    201,
  );
}

/**
 * Appends a message and refreshes the conversation and every participant's
 * inbox entry in one transaction. The sender's entry is also marked read.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param conversation The target conversation
 * @param userId The sender
 * @param message The trimmed message text
 * @param statusCode The success status to return
 * @returns The response containing the stored message
 */
async function sendIntoConversation(
  event: APIGatewayProxyEvent,
  config: Config,
  conversation: ConversationRecord,
  userId: string,
  message: string,
  statusCode: 200 | 201,
): Promise<APIGatewayProxyResult> {
  const now = new Date().toISOString();
  const messageId = newSortableId();
  const { conversationId } = conversation;
  const values = {
    ":at": now,
    ":preview": previewOf(message),
    ":sender": userId,
  };
  const latest =
    "lastMessageAt = :at, lastMessagePreview = :preview, lastMessageSenderId = :sender";

  await dynamodb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: config.messagesTable,
            Item: {
              conversationId,
              messageId,
              senderId: userId,
              body: message,
              createdAt: now,
            } satisfies MessageRecord,
          },
        },
        {
          Update: {
            TableName: config.conversationsTable,
            Key: { conversationId },
            UpdateExpression: `SET ${latest}`,
            ConditionExpression: "attribute_exists(conversationId)",
            ExpressionAttributeValues: values,
          },
        },
        ...conversation.memberIds.map((id) => ({
          Update: {
            TableName: config.conversationMembersTable,
            Key: { userId: id, conversationId },
            UpdateExpression:
              id === userId
                ? `SET ${latest}, lastReadAt = :at`
                : `SET ${latest}`,
            ConditionExpression: "attribute_exists(userId)",
            ExpressionAttributeValues: values,
          },
        })),
      ],
    }),
  );

  return jsonResponse(event, statusCode, {
    conversation: { conversationId },
    message: { messageId, senderId: userId, body: message, createdAt: now },
  });
}

/**
 * Mark Read
 *
 * Sets the caller's read marker on a conversation to now.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param userId The caller
 * @param conversationId The conversation to mark read
 * @returns A 200 response, or 404 when the caller is not a participant
 */
async function markRead(
  event: APIGatewayProxyEvent,
  config: Config,
  userId: string,
  conversationId: string | undefined,
): Promise<APIGatewayProxyResult> {
  if (!conversationId) {
    return jsonResponse(event, 400, { message: "conversationId is required" });
  }
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: config.conversationMembersTable,
        Key: { userId, conversationId },
        UpdateExpression: "SET lastReadAt = :now",
        ConditionExpression: "attribute_exists(userId)",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return jsonResponse(event, 404, { message: "Conversation not found" });
    }
    throw error;
  }
  return jsonResponse(event, 200, { read: true });
}

/**
 * List Colleagues
 *
 * Returns the other active members of an organization the caller belongs to,
 * so the UI can offer them as conversation participants.
 *
 * @param event The API Gateway event
 * @param config The resolved environment configuration
 * @param userId The caller
 * @param organizationId The organization to list
 * @returns A 200 response with the colleagues, or 403 for non-members
 */
async function listColleagues(
  event: APIGatewayProxyEvent,
  config: Config,
  userId: string,
  organizationId: string | undefined,
): Promise<APIGatewayProxyResult> {
  if (!organizationId) {
    return jsonResponse(event, 400, { message: "organizationId is required" });
  }
  if (
    !(await getActiveMembership(
      config.membershipsTable,
      organizationId,
      userId,
    ))
  ) {
    return jsonResponse(event, 403, {
      message: "Active organization membership required",
    });
  }

  const memberships = (
    await queryAll<OrganizationMembership>({
      TableName: config.membershipsTable,
      KeyConditionExpression: "organizationId = :organizationId",
      ExpressionAttributeValues: { ":organizationId": organizationId },
    })
  ).filter(
    (membership) =>
      membership.status === "ACTIVE" && membership.userId !== userId,
  );
  const profiles = await loadProfiles(
    config.usersTable,
    memberships.map((membership) => membership.userId),
  );

  return jsonResponse(event, 200, {
    colleagues: memberships.map((membership) => ({
      userId: membership.userId,
      role: membership.role,
      email: profiles.get(membership.userId)?.email ?? membership.email,
      givenName: profiles.get(membership.userId)?.givenName,
      familyName: profiles.get(membership.userId)?.familyName,
      avatarUrl: profiles.get(membership.userId)?.avatarUrl,
    })),
  });
}
