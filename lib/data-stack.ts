import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";

/**
 * DataStack
 *
 * This stack is responsible for creating the necessary data
 * resources for the Pharmacy Handoff application.
 * 
 */
export class DataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 and DynamoDB resources will be created here in the future
  }
}
