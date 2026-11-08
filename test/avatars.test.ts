import { jest } from "@jest/globals";

import type { AnyMock } from "./helpers";

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(async () => "https://signed.example/avatar"),
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { signedAvatarUrl, withAvatarUrl } from "../lambda/shared/avatars";

const signMock = getSignedUrl as unknown as AnyMock;

describe("avatar URLs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PROFILE_PICTURES_BUCKET_NAME = "bucket";
  });

  afterEach(() => jest.useRealTimers());

  test("signs against the start of the hour so URLs are stable within it", async () => {
    jest.useFakeTimers();

    jest.setSystemTime(new Date("2026-11-08T10:05:00Z"));
    await signedAvatarUrl("avatars/u1/a");
    jest.setSystemTime(new Date("2026-11-08T10:55:00Z"));
    await signedAvatarUrl("avatars/u1/a");
    jest.setSystemTime(new Date("2026-11-08T11:01:00Z"));
    await signedAvatarUrl("avatars/u1/a");

    const dates = signMock.mock.calls.map((call) =>
      (
        call as [unknown, unknown, { signingDate: Date }]
      )[2].signingDate.toISOString(),
    );
    expect(dates).toEqual([
      "2026-11-08T10:00:00.000Z",
      "2026-11-08T10:00:00.000Z",
      "2026-11-08T11:00:00.000Z",
    ]);
    // Still valid for at least an hour after the latest request in a bucket.
    const [, , options] = signMock.mock.calls[0] as [
      unknown,
      unknown,
      { expiresIn: number },
    ];
    expect(options.expiresIn).toBe(2 * 60 * 60);
  });

  test("returns nothing without a configured bucket", async () => {
    delete process.env.PROFILE_PICTURES_BUCKET_NAME;

    expect(await signedAvatarUrl("avatars/u1/a")).toBeUndefined();
  });

  test("withAvatarUrl swaps the internal key for a URL", async () => {
    expect(
      await withAvatarUrl({ userId: "u1", avatarKey: "avatars/u1/a" }),
    ).toEqual({
      userId: "u1",
      avatarUrl: "https://signed.example/avatar",
    });
    expect(await withAvatarUrl({ userId: "u2" })).toEqual({ userId: "u2" });
  });
});
