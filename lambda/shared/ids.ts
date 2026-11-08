import { randomUUID } from "node:crypto";

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
