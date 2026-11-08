import { jest } from "@jest/globals";
import { type AnyMock, makeEvent, parseBody, sentCommands } from "./helpers";

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
jest.mock("../lambda/shared/avatars", () => ({
  ...jest.requireActual<object>("../lambda/shared/avatars"),
  s3: { send: jest.fn() },
  withAvatarUrl: jest.fn(async (item: Record<string, unknown>) => {
    const { avatarKey, ...rest } = item;
    return avatarKey
      ? { ...rest, avatarUrl: `https://signed/${avatarKey}` }
      : rest;
  }),
}));
jest.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: jest.fn(async () => ({
    url: "https://bucket.s3.amazonaws.com/",
    fields: { key: "k" },
  })),
}));

import { s3 } from "../lambda/shared/avatars";
import { dynamodb } from "../lambda/shared/dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { handler } from "../lambda/users/manageSelfProfileResolver";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

const dynamoMock = dynamodb.send as unknown as AnyMock;
const s3Mock = s3.send as unknown as AnyMock;
const cognitoMock = new CognitoIdentityProviderClient({})
  .send as unknown as AnyMock;
const presignMock = createPresignedPost as unknown as AnyMock;

const patch = (body: unknown, sub = "u1") =>
  makeEvent({
    sub,
    httpMethod: "PATCH",
    resource: "/staff/me",
    body: JSON.stringify(body),
  } as never);

const avatar = (body: unknown, sub = "u1") =>
  makeEvent({
    sub,
    httpMethod: "POST",
    resource: "/staff/me/avatar",
    body: JSON.stringify(body),
  } as never);

/** The profile as the table holds it before the update; null means no profile. */
function mockProfile(item: Record<string, unknown> | null = { userId: "u1" }) {
  dynamoMock.mockImplementation(
    async (command: {
      constructor: { name: string };
      input: { ExpressionAttributeValues?: Record<string, unknown> };
    }) => {
      if (command.constructor.name === "GetCommand")
        return { Item: item ?? undefined };
      // Mimic ALL_NEW: the stored item with the SET values applied.
      const applied = Object.fromEntries(
        Object.entries(command.input.ExpressionAttributeValues ?? {}).map(
          ([name, value]) => [name.slice(1), value],
        ),
      );
      return { Attributes: { userId: "u1", ...item, ...applied } };
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USERS_TABLE_NAME = "users";
  process.env.PROFILE_PICTURES_BUCKET_NAME = "bucket";
  process.env.STAFF_USER_POOL_ID = "pool";
  cognitoMock.mockResolvedValue({});
  s3Mock.mockResolvedValue({});
});

describe("PATCH /staff/me", () => {
  test("validates fields", async () => {
    mockProfile();
    for (const body of [
      {},
      { givenName: "  " },
      { givenName: "x".repeat(101) },
      { timeFormat: "25h" },
      { emailUrgentAlerts: "yes" },
      { avatarKey: "avatars/someone-else/abc" },
      { avatarKey: "avatars/u1/" },
      { avatarKey: 5 },
    ]) {
      expect((await handler(patch(body))).statusCode).toBe(400);
    }
    expect(dynamoMock).not.toHaveBeenCalled();
  });

  test("updates names in Cognito and the table, trimmed", async () => {
    mockProfile();

    const response = await handler(
      patch({ givenName: " Ada ", familyName: "Lovelace", timeFormat: "24h" }),
    );

    expect(response.statusCode).toBe(200);
    const [cognitoUpdate] = cognitoMock.mock.calls[0] as [{ input: any }];
    expect(cognitoUpdate.input).toMatchObject({
      UserPoolId: "pool",
      Username: "u1",
      UserAttributes: [
        { Name: "given_name", Value: "Ada" },
        { Name: "family_name", Value: "Lovelace" },
      ],
    });
    const [update] = sentCommands(dynamoMock, "UpdateCommand");
    expect(update.input.Key).toEqual({ userId: "u1" });
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ":givenName": "Ada",
      ":familyName": "Lovelace",
      ":timeFormat": "24h",
    });
  });

  test("does not touch Cognito for preference-only changes", async () => {
    mockProfile();

    await handler(
      patch({ emailNewMessages: true, defaultLocationId: "loc-1" }),
    );

    expect(cognitoMock).not.toHaveBeenCalled();
  });

  test("clears the default location with null", async () => {
    mockProfile();

    await handler(patch({ defaultLocationId: null }));

    const [update] = sentCommands(dynamoMock, "UpdateCommand");
    expect(update.input.UpdateExpression).toContain(
      "REMOVE #defaultLocationId",
    );
  });

  test("never lets a caller edit anyone but themselves", async () => {
    mockProfile();

    await handler(
      patch({ givenName: "A", userId: "victim", email: "x@y.z" }, "u1"),
    );

    const [update] = sentCommands(dynamoMock, "UpdateCommand");
    expect(update.input.Key).toEqual({ userId: "u1" });
    expect(Object.values(update.input.ExpressionAttributeNames)).not.toContain(
      "email",
    );
    expect(Object.values(update.input.ExpressionAttributeNames)).not.toContain(
      "userId",
    );
  });

  test("404s when the profile does not exist", async () => {
    mockProfile(null);

    expect((await handler(patch({ givenName: "A" }))).statusCode).toBe(404);
  });

  describe("avatarKey", () => {
    test("rejects a key that was never uploaded", async () => {
      mockProfile();
      const error = new Error("nf");
      error.name = "NotFound";
      s3Mock.mockRejectedValue(error);

      const response = await handler(patch({ avatarKey: "avatars/u1/abc" }));

      expect(response.statusCode).toBe(400);
      expect(sentCommands(dynamoMock, "UpdateCommand")).toHaveLength(0);
    });

    test("rejects an uploaded object with the wrong type or size", async () => {
      mockProfile();
      for (const head of [
        { ContentType: "text/html", ContentLength: 10 },
        { ContentType: "image/png", ContentLength: 6 * 1024 * 1024 },
      ]) {
        s3Mock.mockResolvedValueOnce(head);
        const response = await handler(patch({ avatarKey: "avatars/u1/abc" }));
        expect(response.statusCode).toBe(400);
      }
    });

    test("saves a valid picture, returns a signed URL, and deletes the old one", async () => {
      mockProfile({ userId: "u1", avatarKey: "avatars/u1/old" });
      s3Mock.mockImplementation(
        async (command: { constructor: { name: string } }) =>
          command.constructor.name === "HeadObjectCommand"
            ? { ContentType: "image/png", ContentLength: 1000 }
            : {},
      );

      const response = await handler(patch({ avatarKey: "avatars/u1/new" }));
      const body = parseBody(response);

      expect(response.statusCode).toBe(200);
      expect(body.avatarUrl).toBe("https://signed/avatars/u1/new");
      expect(body.avatarKey).toBeUndefined();
      const deletes = sentCommands(s3Mock, "DeleteObjectCommand");
      expect(deletes).toHaveLength(1);
      expect(deletes[0].input).toMatchObject({
        Bucket: "bucket",
        Key: "avatars/u1/old",
      });
    });

    test("removing the picture deletes the object", async () => {
      mockProfile({ userId: "u1", avatarKey: "avatars/u1/old" });

      const response = await handler(patch({ avatarKey: null }));

      expect(response.statusCode).toBe(200);
      const [update] = sentCommands(dynamoMock, "UpdateCommand");
      expect(update.input.UpdateExpression).toContain("REMOVE #avatarKey");
      expect(sentCommands(s3Mock, "DeleteObjectCommand")).toHaveLength(1);
    });
  });
});

describe("POST /staff/me/avatar", () => {
  test("rejects non-image content types", async () => {
    for (const contentType of ["text/html", "image/svg+xml", undefined, 3]) {
      expect((await handler(avatar({ contentType }))).statusCode).toBe(400);
    }
    expect(presignMock).not.toHaveBeenCalled();
  });

  test("returns a presigned POST pinned to the caller's prefix, type and size", async () => {
    const response = await handler(avatar({ contentType: "image/png" }, "u1"));
    const body = parseBody(response);

    expect(response.statusCode).toBe(200);
    expect(body.key).toMatch(/^avatars\/u1\/[0-9a-f-]{36}$/);
    expect(body.maxBytes).toBe(5 * 1024 * 1024);

    const [, options] = presignMock.mock.calls[0] as [unknown, any];
    expect(options).toMatchObject({
      Bucket: "bucket",
      Key: body.key,
      Fields: { "Content-Type": "image/png" },
      Expires: 300,
    });
    expect(options.Conditions).toEqual(
      expect.arrayContaining([
        ["content-length-range", 1, 5 * 1024 * 1024],
        ["eq", "$Content-Type", "image/png"],
      ]),
    );
  });
});

test("returns 401 without a caller", async () => {
  const response = await handler(
    makeEvent({
      httpMethod: "PATCH",
      resource: "/staff/me",
      requestContext: {},
    } as never),
  );

  expect(response.statusCode).toBe(401);
});
