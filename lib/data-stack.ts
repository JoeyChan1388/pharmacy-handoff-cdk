import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

/**
 * DataStack
 *
 * This stack is responsible for creating the necessary data
 * resources, table data should never be deleted.
 */
export class DataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Users Table
     *
     * This DynamoDB table will store user profile information for
     * both staff and patients.
     */
    const usersTable = new dynamodb.Table(this, "UsersTable", {
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
    const organizationsTable = new dynamodb.Table(this, "OrganizationsTable", {
      tableName: `${id}-OrganizationsTable`,
      partitionKey: {
        name: "organizationId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    /**
     * Removal Policies
     *
     * The tables' removal policies are set to RETAIN to ensure that the data
     * is not deleted when the stack is deleted.
     */
    usersTable.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    organizationsTable.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  }
}
