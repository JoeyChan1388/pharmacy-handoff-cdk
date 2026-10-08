import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { PostConfirmationTriggerEvent } from "aws-lambda";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Profile Creation Sources
 *
 * These are the Cognito PostConfirmation trigger sources that execute the
 * profile creation logic.
 */
const profileCreationSources = new Set([
  "PostConfirmation_ConfirmSignUp",
  "PostConfirmation_AdminConfirmSignUp",
]);

/**
 * CreateUserProfileResolver Handler
 *
 * Triggered by the PostConfirmation event in Cognito.
 * Creates a user profile in the DynamoDB Users table after a user has
 * successfully confirmed their sign-up.
 *
 * @param event The PostConfirmationTriggerEvent from Cognito containing
 * user attributes.
 * @returns The same PostConfirmationTriggerEvent, allowing the flow to
 * continue unimpeded.
 */
export const handler = async (
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> => {
  if (!profileCreationSources.has(event.triggerSource)) {
    return event;
  }

  const tableName = process.env.USERS_TABLE_NAME;
  const { sub, email, given_name, family_name } = event.request.userAttributes;

  if (!tableName) {
    throw new Error("USERS_TABLE_NAME environment variable is required");
  }
  if (!sub) {
    throw new Error("Cognito confirmation event is missing the user sub");
  }

  const now = new Date().toISOString();
  const expressionNames: Record<string, string> = {
    "#createdAt": "createdAt",
    "#updatedAt": "updatedAt",
  };
  const expressionValues: Record<string, string> = {
    ":createdAt": now,
    ":updatedAt": now,
  };
  const updates = [
    "#createdAt = if_not_exists(#createdAt, :createdAt)",
    "#updatedAt = :updatedAt",
  ];

  const profileAttributes = [
    ["email", email],
    ["givenName", given_name],
    ["familyName", family_name],
  ] as const;

  for (const [attribute, value] of profileAttributes) {
    if (value) {
      const nameToken = `#${attribute}`;
      const valueToken = `:${attribute}`;
      expressionNames[nameToken] = attribute;
      expressionValues[valueToken] = value;
      updates.push(`${nameToken} = ${valueToken}`);
    }
  }

  await dynamodb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { userId: sub },
      UpdateExpression: `SET ${updates.join(", ")}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
    }),
  );

  return event;
};
