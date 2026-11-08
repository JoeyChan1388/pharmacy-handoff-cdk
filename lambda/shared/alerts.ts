/**
 * Partition key shared by every alert in the alerts table.
 */
export const ALERT_FEED = "ALERTS";

/**
 * Maximum alerts returned to a client; older alerts are not listed.
 */
export const ALERT_LIST_LIMIT = 100;

/**
 * Alert severities a platform admin can choose.
 */
export const ALERT_SEVERITIES = ["info", "warning", "danger"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * AlertRecord
 *
 * A platform alert as stored in the alerts table.
 */
export interface AlertRecord {
  feed: string;
  body: string;
  title: string;
  alertId: string;
  createdBy: string;
  createdAt: string;
  severity: AlertSeverity;
}

/**
 * Projects a stored alert to the fields clients see. The sender is not
 * exposed to staff.
 *
 * @param alert The stored alert
 * @returns The public alert fields
 */
export function toPublicAlert(alert: AlertRecord) {
  const { alertId, title, body, severity, createdAt } = alert;
  return { alertId, title, body, severity, createdAt };
}
