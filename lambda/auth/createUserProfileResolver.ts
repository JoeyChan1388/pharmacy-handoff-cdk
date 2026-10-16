import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { dynamodb } from "../shared/dynamodb";
import type { PostConfirmationTriggerEvent } from "aws-lambda";

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
  // See if the trigger source is one of the allowed profile creation sources.
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
    "#status": "status",
  };
  const expressionValues: Record<string, string> = {
    ":createdAt": now,
    ":updatedAt": now,
    ":status": "ACTIVE",
  };
  const updates = [
    "#createdAt = if_not_exists(#createdAt, :createdAt)",
    "#updatedAt = :updatedAt",
    "#status = :status",
  ];

  const profileAttributes = [
    ["email", email],
    ["givenName", given_name],
    ["familyName", family_name],
  ] as const;

  /**
   * Prepare Update Expressions for User Attributes
   *
   * This loop constructs the necessary DynamoDB update expressions for each
   * user attribute that is present. It uses expression attribute names and
   * values to safely update the user's profile in the Users table.
   */
  for (const [attribute, value] of profileAttributes) {
    if (value) {
      const nameToken = `#${attribute}`;
      const valueToken = `:${attribute}`;

      expressionNames[nameToken] = attribute;
      expressionValues[valueToken] = value;
      updates.push(`${nameToken} = ${valueToken}`);
    }
  }

  /**
   * Update User Profile in DynamoDB
   *
   * This is what actually updates the user profile in the Users table.
   */
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
