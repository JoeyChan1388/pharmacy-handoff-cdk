import { jsonResponse } from "../shared/http";
import { dynamodb, queryAll } from "../shared/dynamodb";
import { getCallerUserId } from "../shared/authorization";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ALERT_FEED,
  ALERT_LIST_LIMIT,
  type AlertRecord,
  toPublicAlert,
} from "../shared/alerts";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * Config
 *
 * Table names the resolver reads from the environment.
 */
interface Config {
  alertsTable: string;
  receiptsTable: string;
}

/**
 * Reads the required table names from the environment, throwing when any
 * value is missing so the deployment error surfaces immediately.
 *
 * @returns The resolved configuration
 */
function loadConfig(): Config {
  const config = {
    alertsTable: process.env.ALERTS_TABLE_NAME,
    receiptsTable: process.env.ALERT_RECEIPTS_TABLE_NAME,
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error("Staff alerts Lambda is missing table configuration");
  }
  return config as Config;
}

/**
 * Loads the most recent alerts, newest first.
 *
 * @param config The resolved environment configuration
 * @returns The alert records
 */
async function loadRecentAlerts(config: Config): Promise<AlertRecord[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: config.alertsTable,
      KeyConditionExpression: "feed = :feed",
      ExpressionAttributeValues: { ":feed": ALERT_FEED },
      ScanIndexForward: false,
      Limit: ALERT_LIST_LIMIT,
    }),
  );
  return (result.Items ?? []) as AlertRecord[];
}

/**
 * Loads the IDs of the alerts a user has already read.
 *
 * @param config The resolved environment configuration
 * @param userId The user
 * @returns The set of read alert IDs
 */
async function loadReadIds(
  config: Config,
  userId: string,
): Promise<Set<string>> {
  const receipts = await queryAll<{ alertId: string }>({
    TableName: config.receiptsTable,
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": userId },
  });
  return new Set(receipts.map((receipt) => receipt.alertId));
}

/**
 * Records that a user has read an alert.
 *
 * @param config The resolved environment configuration
 * @param userId The user
 * @param alertId The alert
 */
async function writeReceipt(
  config: Config,
  userId: string,
  alertId: string,
): Promise<void> {
  await dynamodb.send(
    new PutCommand({
      TableName: config.receiptsTable,
      Item: { userId, alertId, readAt: new Date().toISOString() },
    }),
  );
}

/**
 * StaffAlertsResolver Handler
 *
 * Single Lambda for the platform alerts a staff user receives. Alerts go to
 * every staff user, so any authenticated staff caller may read them; read
 * state is kept per user.
 *
 *  - GET  /staff/me/alerts
 *  - POST /staff/me/alerts/read-all
 *  - POST   /staff/me/alerts/{alertId}/read
 *  - DELETE /staff/me/alerts/{alertId}/read  (marks unread)
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

  switch (`${event.httpMethod} ${event.resource}`) {
    case "GET /staff/me/alerts": {
      const [alerts, readIds] = await Promise.all([
        loadRecentAlerts(config),
        loadReadIds(config, userId),
      ]);
      return jsonResponse(event, 200, {
        alerts: alerts.map((alert) => ({
          ...toPublicAlert(alert),
          read: readIds.has(alert.alertId),
        })),
      });
    }

    case "POST /staff/me/alerts/read-all": {
      const [alerts, readIds] = await Promise.all([
        loadRecentAlerts(config),
        loadReadIds(config, userId),
      ]);
      await Promise.all(
        alerts
          .filter((alert) => !readIds.has(alert.alertId))
          .map((alert) => writeReceipt(config, userId, alert.alertId)),
      );
      return jsonResponse(event, 200, { read: true });
    }

    case "POST /staff/me/alerts/{alertId}/read": {
      const alertId = event.pathParameters?.alertId;
      if (!alertId) {
        return jsonResponse(event, 400, { message: "alertId is required" });
      }
      const alert = await dynamodb.send(
        new GetCommand({
          TableName: config.alertsTable,
          Key: { feed: ALERT_FEED, alertId },
        }),
      );
      if (!alert.Item) {
        return jsonResponse(event, 404, { message: "Alert not found" });
      }
      await writeReceipt(config, userId, alertId);
      return jsonResponse(event, 200, { read: true });
    }

    case "DELETE /staff/me/alerts/{alertId}/read": {
      const alertId = event.pathParameters?.alertId;
      if (!alertId) {
        return jsonResponse(event, 400, { message: "alertId is required" });
      }
      await dynamodb.send(
        new DeleteCommand({
          TableName: config.receiptsTable,
          Key: { userId, alertId },
        }),
      );
      return jsonResponse(event, 200, { read: false });
    }

    default:
      return jsonResponse(event, 405, { message: "Method not allowed" });
  }
};
