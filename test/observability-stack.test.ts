import { ApiStack } from "../lib/api-stack";
import { AuthStack } from "../lib/auth-stack";
import { DataStack } from "../lib/data-stack";
import { describe, expect, test } from "@jest/globals";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ObservabilityStack } from "../lib/observability-stack";

import * as cdk from "aws-cdk-lib/core";

describe("ObservabilityStack", () => {
  const app = new cdk.App({
    context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true },
  });
  const dataStack = new DataStack(app, "PharmacyHandoffData");
  const authStack = new AuthStack(app, "PharmacyHandoffAuth", {
    usersTable: dataStack.usersTable,
    organizationMembershipsTable: dataStack.organizationMembershipsTable,
    staffLocationAssignmentsTable: dataStack.staffLocationAssignmentsTable,
  });
  const apiStack = new ApiStack(app, "PharmacyHandoffApi", {
    platformAdminUserIds: ["admin-sub"],
    usersTable: dataStack.usersTable,
    staffUserPool: authStack.staffUserPool,
    locationsTable: dataStack.locationsTable,
    patientUserPool: authStack.patientUserPool,
    organizationsTable: dataStack.organizationsTable,
    organizationMembershipsTable: dataStack.organizationMembershipsTable,
    staffLocationAssignmentsTable: dataStack.staffLocationAssignmentsTable,
  });
  const stack = new ObservabilityStack(app, "PharmacyHandoffObservability", {
    alertEmail: "alerts@example.com",
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
  const template = Template.fromStack(stack);
  const apiTemplate = Template.fromStack(apiStack);

  test("creates an alert topic with a confirmed-by-email subscription", () => {
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "alerts@example.com",
    });
  });

  test("creates one dashboard", () => {
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
  });

  test("creates API, Lambda, and DynamoDB alarms that notify the topic", () => {
    // 2 API + 2 per Lambda + 2 per table
    const expected = 2 + apiStack.functions.length * 2 + 5 * 2;
    template.resourceCountIs("AWS::CloudWatch::Alarm", expected);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmActions: [Match.objectLike({ Ref: Match.anyValue() })],
      TreatMissingData: "notBreaching",
    });
  });

  test("ApiStack turns on access logs, metrics, and tracing", () => {
    apiTemplate.hasResourceProperties("AWS::ApiGateway::Stage", {
      TracingEnabled: true,
      AccessLogSetting: Match.objectLike({
        DestinationArn: Match.anyValue(),
      }),
      MethodSettings: Match.arrayWith([
        Match.objectLike({ MetricsEnabled: true }),
      ]),
    });
    apiTemplate.resourceCountIs("AWS::ApiGateway::Account", 1);
  });

  test("ApiStack Lambdas are traced and have bounded log retention", () => {
    expect(apiStack.functions.length).toBeGreaterThan(0);
    const functions = apiTemplate.findResources("AWS::Lambda::Function", {
      Properties: { TracingConfig: { Mode: "Active" } },
    });
    expect(Object.keys(functions)).toHaveLength(apiStack.functions.length);
    const logGroups = apiTemplate.findResources("AWS::Logs::LogGroup", {
      Properties: { RetentionInDays: 30 },
    });
    // one per Lambda plus the API access log group
    expect(Object.keys(logGroups)).toHaveLength(apiStack.functions.length + 1);
  });
});
