import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  dynamodb,
  isConditionalCheckFailed,
  queryAll,
} from "../shared/dynamodb";

import type { PostAuthenticationTriggerEvent } from "aws-lambda";
import type {
  OrganizationMembership,
  StaffLocationAssignment,
} from "../shared/types";

/**
 * Config
 *
 * Table names the trigger reads from the environment.
 */
interface Config {
  usersTable: string;
  assignmentsTable: string;
  membershipsTable: string;
}

/**
 * Reads the required table names from the environment, throwing when any
 * value is missing so the deployment error surfaces immediately.
 *
 * @returns The resolved configuration
 */
function loadConfig(): Config {
  const config = {
    usersTable: process.env.USERS_TABLE_NAME,
    assignmentsTable: process.env.STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME,
    membershipsTable: process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error("Activate invited user Lambda is missing configuration");
  }
  return config as Config;
}

/**
 * Sets an item's status to ACTIVE, but only if it is currently INVITED, so a
 * DISABLED or otherwise changed record is never reactivated by a login.
 *
 * @param tableName The table holding the item
 * @param key The item's primary key
 */
async function activateIfInvited(
  tableName: string,
  key: Record<string, string>,
): Promise<void> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: "SET #status = :active, #updatedAt = :now",
        ConditionExpression: "#status = :invited",
        ExpressionAttributeNames: {
          "#status": "status",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":active": "ACTIVE",
          ":invited": "INVITED",
          ":now": new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
  }
}

/**
 * ActivateInvitedUserResolver Handler
 *
 * Triggered by the staff user pool's PostAuthentication event, which also
 * fires when an invited user finishes setting their permanent password. It
 * moves the user's profile, organization memberships, and location
 * assignments from INVITED to ACTIVE so they can see their organizations.
 *
 * A failure here is logged but never thrown: it must not lock the user out,
 * and the next successful login retries the activation.
 *
 * @param event The PostAuthenticationTriggerEvent from Cognito
 * @returns The same event, allowing the sign-in to continue
 */
export const handler = async (
  event: PostAuthenticationTriggerEvent,
): Promise<PostAuthenticationTriggerEvent> => {
  const userId = event.request.userAttributes.sub;
  if (!userId) return event;

  try {
    const config = loadConfig();

    const [memberships, assignments] = await Promise.all([
      queryAll<OrganizationMembership>({
        TableName: config.membershipsTable,
        IndexName: "ByUser",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
      }),
      queryAll<StaffLocationAssignment>({
        TableName: config.assignmentsTable,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
      }),
    ]);

    await Promise.all([
      activateIfInvited(config.usersTable, { userId }),
      ...memberships
        .filter((membership) => membership.status === "INVITED")
        .map((membership) =>
          activateIfInvited(config.membershipsTable, {
            organizationId: membership.organizationId,
            userId,
          }),
        ),
      ...assignments
        .filter((assignment) => assignment.status === "INVITED")
        .map((assignment) =>
          activateIfInvited(config.assignmentsTable, {
            userId,
            locationId: assignment.locationId,
          }),
        ),
    ]);
  } catch (error) {
    console.error("Failed to activate invited user", { userId, error });
  }

  return event;
};
