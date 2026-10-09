import { join } from "node:path";
import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as apigateway from "aws-cdk-lib/aws-apigateway";

interface ApiStackProps extends cdk.StackProps {
  usersTable: dynamodb.ITable;
  locationsTable: dynamodb.ITable;
  staffUserPool: cognito.IUserPool;
  patientUserPool: cognito.IUserPool;
  organizationsTable: dynamodb.ITable;
  organizationMembershipsTable: dynamodb.ITable;
  staffLocationAssignmentsTable: dynamodb.ITable;
}

/**
 * ApiStack
 *
 * This stack is responsible for creating the API Gateway resources.
 * The API Gateway will be used to expose the Lambda functions to the
 * front-end applications.
 */
export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const staffWebOrigins = [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ];

    /**
     * PharmacyHandoffApi
     *
     * Primary API Gateway responsible for setting up API endpoints for both
     * staff and patients.
     */
    const api = new apigateway.RestApi(this, "PharmacyHandoffApi", {
      restApiName: `${id}-Api`,
      defaultCorsPreflightOptions: {
        allowOrigins: staffWebOrigins,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type"],
      },
    });

    /**
     * ApiUrl Output
     *
     * This output will display the base URL for the API Gateway in the
     * CloudFormation stack outputs. It can be used to access the API
     * endpoints from the front-end applications.
     */
    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "Base URL for the Pharmacy Handoff API",
    });

    /**
     * Cognito authorizers for staff and patients
     */
    const staffAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "StaffAuthorizer",
      { cognitoUserPools: [props.staffUserPool] },
    );

    /**
     * Patient authorizer for the API Gateway
     */
    const patientAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "PatientAuthorizer",
      { cognitoUserPools: [props.patientUserPool] },
    );

    /**
     * GetUserProfileResolver
     *
     * This Lambda function is responsible for retrieving the user profile
     * information from the DynamoDB users table. It is used by both the staff
     * and patient endpoints. The Lambda function is granted read-only access
     * to the users table.
     */
    const getUserProfileResolver = new NodejsFunction(
      this,
      "getUserProfileResolver",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: join(__dirname, "../lambda/getUserProfileResolver.ts"),
        handler: "handler",
        environment: {
          USERS_TABLE_NAME: props.usersTable.tableName,
          ALLOWED_ORIGINS: staffWebOrigins.join(","),
        },
      },
    );

    // Grant read permissions to the UserProfileResolver Lambda Function
    props.usersTable.grantReadData(getUserProfileResolver);

    // Create a Lambda integration for the GetUserProfileResolver
    const integration = new apigateway.LambdaIntegration(
      getUserProfileResolver,
    );

    /**
     * InviteOrganizationStaff Lambda Function
     * 
     * This Lambda function is responsible for inviting new staff members to an
     * organization. It creates a new user in the Cognito Staff User Pool and 
     * adds the user to the DynamoDB Users table.
     */
    const inviteStaff = new NodejsFunction(this, "InviteOrganizationStaffResolver", {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: join(__dirname, "../lambda/inviteOrganizationStaffResolver.ts"),
      handler: "handler",
      environment: {
        STAFF_USER_POOL_ID: props.staffUserPool.userPoolId,
        USERS_TABLE_NAME: props.usersTable.tableName,
        ORGANIZATIONS_TABLE_NAME: props.organizationsTable.tableName,
        LOCATIONS_TABLE_NAME: props.locationsTable.tableName,
        STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME:
          props.staffLocationAssignmentsTable.tableName,
        ORGANIZATION_MEMBERSHIPS_TABLE_NAME:
          props.organizationMembershipsTable.tableName,
        ALLOWED_ORIGINS: staffWebOrigins.join(","),
      },
    });

    /**
     * Iam Policies for InviteOrganizationStaff Lambda Function
     */
    inviteStaff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"],
        resources: [props.staffUserPool.userPoolArn],
      }),
    );
    inviteStaff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [
          props.organizationsTable.tableArn,
          props.locationsTable.tableArn,
          props.organizationMembershipsTable.tableArn,
        ],
      }),
    );
    inviteStaff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [props.usersTable.tableArn],
      }),
    );
    inviteStaff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [props.organizationMembershipsTable.tableArn],
      }),
    );
    inviteStaff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem"],
        resources: [props.staffLocationAssignmentsTable.tableArn],
      }),
    );

    /**
     * /staff/me Resource
     */
    const staffMe = api.root.addResource("staff").addResource("me");

    /**
     * /patient/me Resource
     */
    const patientMe = api.root.addResource("patient").addResource("me");

    /**
     * /organizations/{organizationId}/staff Resource
     */
    const organizationStaff = api.root
      .addResource("organizations")
      .addResource("{organizationId}")
      .addResource("staff");

    /**
     * GET /staff/me and GET /patient/me Methods
     *
     * These methods are protected by Cognito authorizers and will return the
     * user profile information for the authenticated user.
     */
    staffMe.addMethod("GET", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: staffAuthorizer,
    });
    patientMe.addMethod("GET", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: patientAuthorizer,
    });

    /**
     * POST /organizations/{organizationId}/staff Method
     *
     * This method is protected by the staff Cognito authorizer and will allow
     * staff members to invite other staff members to join the organization.
     * The Lambda function will handle the invitation process and create a new
     * user profile in the DynamoDB users table.
     */
    organizationStaff.addMethod(
      "POST",
      new apigateway.LambdaIntegration(inviteStaff),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );
  }
}
