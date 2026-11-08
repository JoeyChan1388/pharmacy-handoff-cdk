import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * S3 Client
 *
 * Shared client instance reused across Lambda invocations.
 */
export const s3 = new S3Client({});

/**
 * Image types accepted for profile pictures.
 */
export const AVATAR_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/**
 * Maximum profile picture size in bytes (5 MB).
 */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Signed view URLs are stamped with the start of the current hour and last two
 * hours, so every request within an hour gets the same URL (the browser can
 * cache the image and polling does not reload it) and each URL is still valid
 * for at least another hour.
 */
const HOUR_MS = 60 * 60 * 1000;
const VIEW_URL_TTL_SECONDS = 2 * 60 * 60;

/**
 * Key prefix for a user's pictures. Keys outside it are never accepted, so a
 * user can only ever reference objects they uploaded under their own ID.
 *
 * @param userId The user's ID
 * @returns The prefix, ending in a slash
 */
export function avatarKeyPrefix(userId: string): string {
  return `avatars/${userId}/`;
}

/**
 * Key prefix for an organization's logos. Keys outside it are never accepted
 * for that organization.
 *
 * @param organizationId The organization's ID
 * @returns The prefix, ending in a slash
 */
export function logoKeyPrefix(organizationId: string): string {
  return `organizations/${organizationId}/logos/`;
}

/**
 * Builds a short-lived URL for viewing an uploaded image (profile picture or
 * organization logo).
 *
 * @param key The object key stored on the profile or organization
 * @returns The signed URL, or undefined when no bucket is configured
 */
export async function signedAvatarUrl(
  key: string,
): Promise<string | undefined> {
  const bucket = process.env.PROFILE_PICTURES_BUCKET_NAME;
  if (!bucket) return undefined;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: VIEW_URL_TTL_SECONDS,
    signingDate: new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS),
  });
}

/**
 * Prepares a stored user item for a client: swaps the internal avatar key for
 * a signed view URL.
 *
 * @param item The user item from DynamoDB
 * @returns The item without avatarKey, plus avatarUrl when a picture is set
 */
export async function withAvatarUrl(
  item: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { avatarKey, ...rest } = item;
  if (typeof avatarKey !== "string") return rest;
  return { ...rest, avatarUrl: await signedAvatarUrl(avatarKey) };
}

/**
 * Prepares a stored organization item for a client: swaps the internal logo
 * key for a signed view URL, so S3 keys never leave the API.
 *
 * @param item The organization item from DynamoDB
 * @returns The item without logoKey, plus logoUrl when a logo is set
 */
export async function withLogoUrl(
  item: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { logoKey, ...rest } = item;
  if (typeof logoKey !== "string") return rest;
  return { ...rest, logoUrl: await signedAvatarUrl(logoKey) };
}
