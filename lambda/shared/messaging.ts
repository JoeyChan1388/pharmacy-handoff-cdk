import { randomUUID } from "node:crypto";
import { signedAvatarUrl } from "./avatars";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { batchGetAll, dynamodb } from "./dynamodb";

import type { OrganizationMembership } from "./types";

/**
 * Maximum length of a single message body.
 */
export const MESSAGE_MAX_LENGTH = 4000;

/**
 * Maximum participants in one conversation, including the creator.
 */
export const CONVERSATION_MAX_MEMBERS = 25;

/**
 * Maximum length of the message preview stored on conversation items.
 */
const PREVIEW_MAX_LENGTH = 140;

/**
 * PublicProfile
 *
 * The profile fields shown to other staff. Deliberately excludes status and
 * pool details.
 */
export interface PublicProfile {
  userId: string;
  email?: string;
  givenName?: string;
  avatarUrl?: string;
  familyName?: string;
}

/**
 * Collapses whitespace and truncates a message body for list previews.
 *
 * @param body The full message body
 * @returns A single-line preview of at most 140 characters
 */
export function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX_LENGTH
    ? `${flat.slice(0, PREVIEW_MAX_LENGTH - 1)}…`
    : flat;
}

/**
 * Builds a sortable, URL-safe unique ID: a zero-padded millisecond timestamp
 * followed by a UUID, so lexical order is chronological order.
 *
 * @param now The timestamp in milliseconds
 * @returns The new ID
 */
export function newSortableId(now: number = Date.now()): string {
  return `${String(now).padStart(13, "0")}-${randomUUID()}`;
}

/**
 * Loads a user's membership in an organization and returns it only when it is
 * ACTIVE.
 *
 * @param membershipsTable The memberships table name
 * @param organizationId The organization to check
 * @param userId The user to check
 * @returns The membership, or undefined when absent or not active
 */
export async function getActiveMembership(
  membershipsTable: string,
  organizationId: string,
  userId: string,
): Promise<OrganizationMembership | undefined> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: membershipsTable,
      Key: { organizationId, userId },
    }),
  );
  const membership = result.Item as OrganizationMembership | undefined;
  return membership?.status === "ACTIVE" ? membership : undefined;
}

/**
 * Loads the public profiles for a set of users.
 *
 * @param usersTable The users table name
 * @param userIds The users to load; duplicates are ignored
 * @returns A map of userId to profile; unknown users are omitted
 */
export async function loadProfiles(
  usersTable: string,
  userIds: string[],
): Promise<Map<string, PublicProfile>> {
  const unique = [...new Set(userIds)];
  const items = await batchGetAll<PublicProfile & { avatarKey?: string }>(
    usersTable,
    unique.map((userId) => ({ userId })),
  );
  const profiles = await Promise.all(
    items.map(async ({ userId, email, givenName, familyName, avatarKey }) => ({
      userId,
      email,
      givenName,
      familyName,
      avatarUrl: avatarKey ? await signedAvatarUrl(avatarKey) : undefined,
    })),
  );
  return new Map(profiles.map((profile) => [profile.userId, profile]));
}
