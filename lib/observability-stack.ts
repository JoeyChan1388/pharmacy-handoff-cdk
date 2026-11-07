import { Construct } from "constructs";

import * as cdk from "aws-cdk-lib/core";
import * as sns from "aws-cdk-lib/aws-sns";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";

/**
 * ObservabilityStackProps
 *
 * The resources the observability stack monitors, and where alerts go.
 */
interface ObservabilityStackProps extends cdk.StackProps {
  alertEmail: string;
  api: apigateway.RestApi;
  functions: lambda.IFunction[];
  tables: Record<string, dynamodb.ITable>;
}

/**
 * Alarm Thresholds
 *
 * Central place to tune when the on-call email fires.
 */
const API_P99_LATENCY_THRESHOLD_MS = 3000;

/**
 * Tracked DynamoDB Operations
 *
 * CloudWatch alarms on math expressions allow at most 10 metrics, so this
 * covers the data-plane operations rather than every DynamoDB operation.
 */
const TRACKED_OPERATIONS = [
  dynamodb.Operation.GET_ITEM,
  dynamodb.Operation.PUT_ITEM,
  dynamodb.Operation.UPDATE_ITEM,
  dynamodb.Operation.DELETE_ITEM,
  dynamodb.Operation.QUERY,
  dynamodb.Operation.SCAN,
  dynamodb.Operation.BATCH_GET_ITEM,
  dynamodb.Operation.BATCH_WRITE_ITEM,
  dynamodb.Operation.TRANSACT_WRITE_ITEMS,
];

/**
 * Table Metric
 *
 * Sums a per-operation DynamoDB metric across the tracked operations for one
 * table. Metric ids are prefixed per table so several tables can share one
 * graph without id collisions.
 *
 * @param metricName - DynamoDB metric, e.g. ThrottledRequests.
 * @param table - Table to measure.
 * @param index - Unique index for this table, used to build metric ids.
 * @param label - Legend label.
 * @param period - Metric period.
 * @returns A math expression summing the metric over all tracked operations.
 */
function tableMetric(
  metricName: string,
  table: dynamodb.ITable,
  index: number,
  label: string,
  period: cdk.Duration,
): cloudwatch.MathExpression {
  const usingMetrics: Record<string, cloudwatch.IMetric> = {};
  TRACKED_OPERATIONS.forEach((operation, i) => {
    usingMetrics[`t${index}o${i}`] = new cloudwatch.Metric({
      namespace: "AWS/DynamoDB",
      metricName,
      dimensionsMap: { TableName: table.tableName, Operation: operation },
      statistic: "Sum",
      period,
    });
  });
  return new cloudwatch.MathExpression({
    expression: "SUM(METRICS())",
    usingMetrics,
    label,
    period,
  });
}

/**
 * ObservabilityStack
 *
 * Owns the alerting topic, CloudWatch alarms, and the operations dashboard
 * for the API, Lambda functions, and DynamoDB tables. It only reads metrics
 * from the other stacks, so it can be deployed or destroyed independently.
 */
export class ObservabilityStack extends cdk.Stack {
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    /**
     * Alert Topic
     *
     * All alarms publish here. The email subscription must be confirmed by
     * clicking the link AWS sends after the first deploy.
     */
    this.alertTopic = new sns.Topic(this, "AlertTopic", {
      displayName: "Pharmacy Handoff alerts",
      enforceSSL: true,
    });
    this.alertTopic.addSubscription(
      new subscriptions.EmailSubscription(props.alertEmail),
    );
    const alarmAction = new cloudwatchActions.SnsAction(this.alertTopic);

    const alarms: cloudwatch.Alarm[] = [];
    const addAlarm = (
      alarmId: string,
      metric: cloudwatch.IMetric,
      options: {
        description: string;
        evaluationPeriods?: number;
        threshold: number;
      },
    ): void => {
      const alarm = new cloudwatch.Alarm(this, alarmId, {
        metric,
        threshold: options.threshold,
        evaluationPeriods: options.evaluationPeriods ?? 1,
        alarmDescription: options.description,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(alarmAction);
      alarms.push(alarm);
    };

    const fiveMinutes = cdk.Duration.minutes(5);

    /**
     * API alarms
     */
    addAlarm(
      "Api5xxAlarm",
      props.api.metricServerError({ period: fiveMinutes }),
      {
        threshold: 1,
        description: "API Gateway returned at least one 5XX in 5 minutes",
      },
    );
    addAlarm(
      "ApiLatencyP99Alarm",
      props.api.metricLatency({ statistic: "p99", period: fiveMinutes }),
      {
        threshold: API_P99_LATENCY_THRESHOLD_MS,
        evaluationPeriods: 3,
        description: `API p99 latency at or above ${API_P99_LATENCY_THRESHOLD_MS}ms for 15 minutes`,
      },
    );

    /**
     * Lambda alarms
     */
    for (const fn of props.functions) {
      const name = fn.node.id;
      addAlarm(`${name}ErrorsAlarm`, fn.metricErrors({ period: fiveMinutes }), {
        threshold: 1,
        description: `${name} had at least one error in 5 minutes`,
      });
      addAlarm(
        `${name}ThrottlesAlarm`,
        fn.metricThrottles({ period: fiveMinutes }),
        {
          threshold: 1,
          description: `${name} was throttled at least once in 5 minutes`,
        },
      );
    }

    /**
     * DynamoDB alarms
     */
    for (const [index, [name, table]] of Object.entries(
      props.tables,
    ).entries()) {
      addAlarm(
        `${name}TableThrottlesAlarm`,
        tableMetric("ThrottledRequests", table, index, name, fiveMinutes),
        {
          threshold: 1,
          description: `${name} table had throttled requests in 5 minutes`,
        },
      );
      addAlarm(
        `${name}TableSystemErrorsAlarm`,
        tableMetric("SystemErrors", table, index, name, fiveMinutes),
        {
          threshold: 1,
          description: `${name} table had DynamoDB system errors in 5 minutes`,
        },
      );
    }

    /**
     * Operations Dashboard
     */
    const dashboard = new cloudwatch.Dashboard(this, "OperationsDashboard", {
      dashboardName: "PharmacyHandoff-Operations",
    });
    const oneMinute = cdk.Duration.minutes(1);
    const percentiles = ["p50", "p90", "p99"];

    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: "Alarm status",
        width: 24,
        height: 4,
        alarms,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "API latency (end to end)",
        width: 12,
        left: percentiles.map((statistic) =>
          props.api.metricLatency({
            statistic,
            period: oneMinute,
            label: statistic,
          }),
        ),
      }),
      new cloudwatch.GraphWidget({
        title: "API integration latency (backend only)",
        width: 12,
        left: percentiles.map((statistic) =>
          props.api.metricIntegrationLatency({
            statistic,
            period: oneMinute,
            label: statistic,
          }),
        ),
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "API requests",
        width: 12,
        left: [props.api.metricCount({ period: oneMinute, label: "Requests" })],
      }),
      new cloudwatch.GraphWidget({
        title: "API errors",
        width: 12,
        left: [
          props.api.metricClientError({ period: oneMinute, label: "4XX" }),
          props.api.metricServerError({ period: oneMinute, label: "5XX" }),
        ],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Lambda errors",
        width: 8,
        left: props.functions.map((fn) =>
          fn.metricErrors({ period: oneMinute, label: fn.node.id }),
        ),
      }),
      new cloudwatch.GraphWidget({
        title: "Lambda duration (p99)",
        width: 8,
        left: props.functions.map((fn) =>
          fn.metricDuration({
            statistic: "p99",
            period: oneMinute,
            label: fn.node.id,
          }),
        ),
      }),
      new cloudwatch.GraphWidget({
        title: "Lambda throttles",
        width: 8,
        left: props.functions.map((fn) =>
          fn.metricThrottles({ period: oneMinute, label: fn.node.id }),
        ),
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "DynamoDB throttled requests",
        width: 12,
        left: Object.entries(props.tables).map(([name, table], index) =>
          tableMetric("ThrottledRequests", table, index, name, oneMinute),
        ),
      }),
      new cloudwatch.GraphWidget({
        title: "DynamoDB system errors",
        width: 12,
        left: Object.entries(props.tables).map(([name, table], index) =>
          tableMetric("SystemErrors", table, index, name, oneMinute),
        ),
      }),
    );
  }
}
