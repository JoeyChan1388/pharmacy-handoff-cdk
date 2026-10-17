import { Construct } from "constructs";

import * as cdk from "aws-cdk-lib/core";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

/**
 * DataStack
 *
 * This stack is responsible for creating the necessary data
 * resources, table data should never be deleted.
 */
export class DataStack extends cdk.Stack {
  public readonly usersTable: dynamodb.Table;
  public readonly locationsTable: dynamodb.Table;
  public readonly organizationsTable: dynamodb.Table;
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
  }
}
