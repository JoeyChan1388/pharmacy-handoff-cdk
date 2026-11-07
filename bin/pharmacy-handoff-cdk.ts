import { ApiStack } from "../lib/api-stack";
import { AuthStack } from "../lib/auth-stack";
import { DataStack } from "../lib/data-stack";
import { ObservabilityStack } from "../lib/observability-stack";

import * as cdk from "aws-cdk-lib/core";

const app = new cdk.App();

/**
 * Platform Admin User IDs
 *
 * These are the Cognito user IDs of the platform administrators who have
 * elevated privileges to manage organizations and other high-level tasks.
 */
const platformAdminUserIds = (
  app.node.tryGetContext("platformAdminUserIds") ??
  process.env.PLATFORM_ADMIN_USER_IDS ??
  "1c4d6588-e021-700e-d0f6-a3e6412e6a4c"
)
  .split(",")
  .map((userId: string) => userId.trim())
  .filter(Boolean);

/**
 * Alert Email
 *
 * Address subscribed to the alarm SNS topic. Override with
 * `-c alertEmail=...` or the ALERT_EMAIL environment variable.
 */
const alertEmail: string =
  app.node.tryGetContext("alertEmail") ??
  process.env.ALERT_EMAIL ??
  "joey.chan0831@gmail.com";

/**
 * Stacks
 */
const dataStack = new DataStack(app, "PharmacyHandoffData");
const authStack = new AuthStack(app, "PharmacyHandoffAuth", {
  usersTable: dataStack.usersTable,
});
const apiStack = new ApiStack(app, "PharmacyHandoffApi", {
  platformAdminUserIds,
  usersTable: dataStack.usersTable,
  staffUserPool: authStack.staffUserPool,
  locationsTable: dataStack.locationsTable,
  patientUserPool: authStack.patientUserPool,
  organizationsTable: dataStack.organizationsTable,
  organizationMembershipsTable: dataStack.organizationMembershipsTable,
  staffLocationAssignmentsTable: dataStack.staffLocationAssignmentsTable,
});
new ObservabilityStack(app, "PharmacyHandoffObservability", {
  alertEmail,
  api: apiStack.api,
  functions: apiStack.functions,
  tables: {
    Users: dataStack.usersTable,
    Locations: dataStack.locationsTable,
    Organizations: dataStack.organizationsTable,
    OrganizationMemberships: dataStack.organizationMembershipsTable,
    StaffLocationAssignments: dataStack.staffLocationAssignmentsTable,
  },
});
