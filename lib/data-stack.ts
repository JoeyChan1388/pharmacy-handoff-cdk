import { Construct } from "constructs";
import { AllowedWebOrigins } from "./web-origins";

import * as cdk from "aws-cdk-lib/core";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

/**
 * DataStack
 *
 * This stack is responsible for creating the necessary data
 * resources, table data should never be deleted.
 */
export class DataStack extends cdk.Stack {
  public readonly usersTable: dynamodb.Table;
  public readonly alertsTable: dynamodb.Table;
  public readonly messagesTable: dynamodb.Table;
  public readonly locationsTable: dynamodb.Table;
  public readonly profilePicturesBucket: s3.Bucket;
  public readonly organizationsTable: dynamodb.Table;
  public readonly conversationsTable: dynamodb.Table;
  public readonly alertReceiptsTable: dynamodb.Table;
  public readonly conversationMembersTable: dynamodb.Table;
  public readonly organizationMembershipsTable: dynamodb.Table;
  public readonly staffLocationAssignmentsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Users Table
     *
     * This DynamoDB table will store user profile information for
     * both staff and patients.
     */
    this.usersTable = new dynamodb.Table(this, "UsersTable", {
      tableName: `${id}-UsersTable`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    /**
     * Organizations Table
     *
     * This DynamoDB table stores information about organizations, organizations
     * can contain multiple pharmacy locations.
     */
    this.organizationsTable = new dynamodb.Table(this, "OrganizationsTable", {
      tableName: `${id}-OrganizationsTable`,
      partitionKey: {
        name: "organizationId",
        type: dynamodb.AttributeType.STRING,
      },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    /**
     * Locations Table
     *
     * Locations are scoped to an organization. The sort key allows listing
     * every pharmacy location that belongs to an organization.
     */
    this.locationsTable = new dynamodb.Table(this, "LocationsTable", {
      tableName: `${id}-LocationsTable`,
      partitionKey: {
        name: "organizationId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "locationId",
        type: dynamodb.AttributeType.STRING,
      },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    /**
     * Staff Location Assignments Table
     *
     * The primary key lists locations for a staff member. The GSI lists
     * staff assigned to a location.
     */
    this.staffLocationAssignmentsTable = new dynamodb.Table(
      this,
      "StaffLocationAssignmentsTable",
      {
        tableName: `${id}-StaffLocationAssignmentsTable`,
        partitionKey: {
          name: "userId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: {
          name: "locationId",
          type: dynamodb.AttributeType.STRING,
        },
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: true,
        },
        deletionProtection: true,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      },
    );

    /**
     * Global Secondary Index for Staff Location Assignments Table
     *
     * This GSI allows querying staff members assigned to a specific location.
     */
    this.staffLocationAssignmentsTable.addGlobalSecondaryIndex({
      indexName: "ByLocation",
      partitionKey: {
        name: "locationId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "userId",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    /**
     * Organization Memberships Table
     *
     * Stores each user's organization-scoped role, such as STAFF or ADMIN.
     * The GSI supports listing an individual user's organizations.
     */
    this.organizationMembershipsTable = new dynamodb.Table(
      this,
      "OrganizationMembershipsTable",
      {
        tableName: `${id}-OrganizationMembershipsTable`,
        partitionKey: {
          name: "organizationId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: {
          name: "userId",
          type: dynamodb.AttributeType.STRING,
        },
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: true,
        },
        deletionProtection: true,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      },
    );

    /**
     * Global Secondary Index for Organization Memberships Table
     *
     * This GSI allows querying the organizations a user belongs to.
     */
    this.organizationMembershipsTable.addGlobalSecondaryIndex({
      indexName: "ByUser",
      partitionKey: {
        name: "userId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "organizationId",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    /**
     * Conversations Table
     *
     * One item per staff conversation (direct or group). Conversations never
     * span organizations. Holds the participant list and the latest message.
     */
    this.conversationsTable = new dynamodb.Table(this, "ConversationsTable", {
      tableName: `${id}-ConversationsTable`,
      partitionKey: {
        name: "conversationId",
        type: dynamodb.AttributeType.STRING,
      },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    /**
     * Conversation Members Table
     *
     * One item per participant per conversation. Querying by userId lists a
     * user's inbox; each item carries that user's read marker and a copy of
     * the latest message so the inbox needs no per-conversation lookups.
     */
    this.conversationMembersTable = new dynamodb.Table(
      this,
      "ConversationMembersTable",
      {
        tableName: `${id}-ConversationMembersTable`,
        partitionKey: {
          name: "userId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: {
          name: "conversationId",
          type: dynamodb.AttributeType.STRING,
        },
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: true,
        },
        deletionProtection: true,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      },
    );

    /**
     * Messages Table
     *
     * Messages keyed by conversation. The sort key starts with a zero-padded
     * timestamp so a query returns them in chronological order.
     */
    this.messagesTable = new dynamodb.Table(this, "MessagesTable", {
      tableName: `${id}-MessagesTable`,
      partitionKey: {
        name: "conversationId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "messageId", type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    /**
     * Alerts Table
     *
     * Platform-wide alerts sent to every staff user. All alerts share one
     * partition key; the time-ordered sort key lists newest first. Volume is
     * low (platform admin broadcasts), so a single partition is fine.
     */
    this.alertsTable = new dynamodb.Table(this, "AlertsTable", {
      tableName: `${id}-AlertsTable`,
      partitionKey: { name: "feed", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "alertId", type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    /**
     * Alert Receipts Table
     *
     * One item per user per alert they have read. Unread is the absence of
     * a receipt, so sending an alert writes nothing per user.
     */
    this.alertReceiptsTable = new dynamodb.Table(this, "AlertReceiptsTable", {
      tableName: `${id}-AlertReceiptsTable`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "alertId", type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    /**
     * Profile Pictures Bucket
     *
     * Private bucket for user profile pictures. Nothing is public: browsers
     * upload with short-lived presigned POSTs (size- and type-restricted by
     * the policy) and view with short-lived presigned GETs. Objects are kept
     * when the stack is deleted.
     */
    this.profilePicturesBucket = new s3.Bucket(this, "ProfilePicturesBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins: AllowedWebOrigins,
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
    });

    /**
     * Removal Policies
     *
     * The tables' removal policies are set to RETAIN to ensure that the data
     * is not deleted when the stack is deleted.
     */
    this.usersTable.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    this.organizationsTable.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    this.locationsTable.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    this.staffLocationAssignmentsTable.applyRemovalPolicy(
      cdk.RemovalPolicy.RETAIN,
    );
    this.organizationMembershipsTable.applyRemovalPolicy(
      cdk.RemovalPolicy.RETAIN,
    );
    this.conversationsTable.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    this.conversationMembersTable.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    this.messagesTable.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    this.alertsTable.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    this.alertReceiptsTable.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  }
}
