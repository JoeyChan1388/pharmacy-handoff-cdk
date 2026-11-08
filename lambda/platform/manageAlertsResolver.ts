import { jsonResponse } from "../shared/http";
import { dynamodb } from "../shared/dynamodb";
import { newSortableId } from "../shared/messaging";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { parseJsonBody, requiredText } from "../shared/validation";
import {
  authorizePlatformAdmin,
  getCallerUserId,
} from "../shared/authorization";
import {
  ALERT_FEED,
  ALERT_LIST_LIMIT,
  ALERT_SEVERITIES,
  type AlertRecord,
  type AlertSeverity,
} from "../shared/alerts";

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * Maximum length of an alert title.
 */
const TITLE_MAX_LENGTH = 120;

/**
 * Maximum length of an alert body.
 */
const BODY_MAX_LENGTH = 2000;

/**
 * ManageAlertsResolver Handler
 *
 * Platform admin endpoint for broadcast alerts. An alert is delivered to
 * every staff user in every organization; it is stored once and each user's
 * read state is tracked separately.
 *
 *  - POST /platform/alerts  Sends an alert
 *  - GET  /platform/alerts  Lists recently sent alerts
 *
 * @param event The API Gateway event
 * @returns The response for the matched method
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const authorizationError = authorizePlatformAdmin(event);
  if (authorizationError) return authorizationError;

  const alertsTable = process.env.ALERTS_TABLE_NAME;
  if (!alertsTable) throw new Error("ALERTS_TABLE_NAME is required");

  switch (event.httpMethod) {
    case "GET": {
      const result = await dynamodb.send(
        new QueryCommand({
          TableName: alertsTable,
          KeyConditionExpression: "feed = :feed",
          ExpressionAttributeValues: { ":feed": ALERT_FEED },
          ScanIndexForward: false,
          Limit: ALERT_LIST_LIMIT,
        }),
      );
      return jsonResponse(event, 200, { alerts: result.Items ?? [] });
    }

    case "POST": {
      const body = parseJsonBody<{
        body?: unknown;
        title?: unknown;
        severity?: unknown;
      }>(event);
      if (!body) {
        return jsonResponse(event, 400, {
          message: "Request body must be valid JSON",
        });
      }

      const title = requiredText(body.title, TITLE_MAX_LENGTH);
      const text = requiredText(body.body, BODY_MAX_LENGTH);
      const severity = body.severity ?? "info";
      if (!title) {
        return jsonResponse(event, 400, {
          message: `title is required and must be at most ${TITLE_MAX_LENGTH} characters`,
        });
      }
      if (!text) {
        return jsonResponse(event, 400, {
          message: `body is required and must be at most ${BODY_MAX_LENGTH} characters`,
        });
      }
      if (!ALERT_SEVERITIES.includes(severity as AlertSeverity)) {
        return jsonResponse(event, 400, {
          message: `severity must be one of: ${ALERT_SEVERITIES.join(", ")}`,
        });
      }

      const alert: AlertRecord = {
        feed: ALERT_FEED,
        alertId: newSortableId(),
        title,
        body: text,
        severity: severity as AlertSeverity,
        createdBy: getCallerUserId(event) as string,
        createdAt: new Date().toISOString(),
      };
      await dynamodb.send(
        new PutCommand({ TableName: alertsTable, Item: alert }),
      );
      return jsonResponse(event, 201, { alert });
    }

    default:
      return jsonResponse(event, 405, { message: "Method not allowed" });
  }
};
