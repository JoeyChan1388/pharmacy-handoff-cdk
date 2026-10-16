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
  platformAdminUserIds: string[];
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

    if (props.platformAdminUserIds.length === 0) {
      throw new Error(
        "ApiStack requires at least one platform admin Cognito sub",
      );
    }

    /**
     * Allowed Origins
     *
     * This set of allowed origins will be used to configure CORS for the
     * API Gateway. It will allow requests from the front-end applications
     * running on localhost and the production domains.
     */
    const AllowedWebOrigins = [
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
        allowOrigins: AllowedWebOrigins,
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
        entry: join(__dirname, "../lambda/users/getUserProfileResolver.ts"),
        handler: "handler",
        environment: {
          USERS_TABLE_NAME: props.usersTable.tableName,
          ALLOWED_ORIGINS: AllowedWebOrigins.join(","),
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
    const inviteStaff = new NodejsFunction(
      this,
      "InviteOrganizationStaffResolver",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: join(
          __dirname,
          "../lambda/organizations/inviteOrganizationStaffResolver.ts",
        ),
        handler: "handler",
        description:
          "Lambda function to invite staff members to an organization",
        environment: {
          STAFF_USER_POOL_ID: props.staffUserPool.userPoolId,
          USERS_TABLE_NAME: props.usersTable.tableName,
          ORGANIZATIONS_TABLE_NAME: props.organizationsTable.tableName,
          LOCATIONS_TABLE_NAME: props.locationsTable.tableName,
          STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME:
            props.staffLocationAssignmentsTable.tableName,
          ORGANIZATION_MEMBERSHIPS_TABLE_NAME:
            props.organizationMembershipsTable.tableName,
          ALLOWED_ORIGINS: AllowedWebOrigins.join(","),
        },
      },
    );

    /**
     * IAM Policies for InviteOrganizationStaff Lambda Function
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
        actions: ["dynamodb:UpdateItem"],
        resources: [props.staffLocationAssignmentsTable.tableArn],
      }),
    );

    /**
     * GetStaffOrganizations Lambda Function
     *
     * This Lambda function is responsible for retrieving the organizations
     * and locations that a staff member is associated with.
     */
    const getStaffOrganizations = new NodejsFunction(
      this,
      "GetStaffOrganizationsResolver",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: join(
          __dirname,
          "../lambda/organizations/getStaffOrganizationsResolver.ts",
        ),
        handler: "handler",
        environment: {
          ORGANIZATIONS_TABLE_NAME: props.organizationsTable.tableName,
          LOCATIONS_TABLE_NAME: props.locationsTable.tableName,
          ORGANIZATION_MEMBERSHIPS_TABLE_NAME:
            props.organizationMembershipsTable.tableName,
          STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME:
            props.staffLocationAssignmentsTable.tableName,
          ALLOWED_ORIGINS: AllowedWebOrigins.join(","),
        },
      },
    );

    /**
     * Grant Table Read Permissions to GetStaffOrganizations Lambda Function
     */
    props.organizationsTable.grantReadData(getStaffOrganizations);
    props.locationsTable.grantReadData(getStaffOrganizations);
    props.organizationMembershipsTable.grantReadData(getStaffOrganizations);
    props.staffLocationAssignmentsTable.grantReadData(getStaffOrganizations);

    /**
     * CreateOrganization Lambda Function
     *
     * This Lambda function is responsible for creating a new organization.
     * It requires the user to be a platform admin, and it creates a new
     * organization in the DynamoDB organizations table, as well as a new
     * user profile for the organization admin in the users table.
     */
    const createOrganization = new NodejsFunction(
      this,
      "CreateOrganizationResolver",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: join(
          __dirname,
          "../lambda/organizations/createOrganizationResolver.ts",
        ),
        handler: "handler",
        environment: {
          STAFF_USER_POOL_ID: props.staffUserPool.userPoolId,
          PLATFORM_ADMIN_USER_IDS: props.platformAdminUserIds.join(","),
          USERS_TABLE_NAME: props.usersTable.tableName,
          ORGANIZATIONS_TABLE_NAME: props.organizationsTable.tableName,
          ORGANIZATION_MEMBERSHIPS_TABLE_NAME:
            props.organizationMembershipsTable.tableName,
          ALLOWED_ORIGINS: AllowedWebOrigins.join(","),
        },
      },
    );

    /**
     * ListPlatformUsers Lambda Function
     *
     * This Lambda function is responsible for listing all platform users.
     * It requires the user to be a platform admin, and it retrieves all
     * users from the DynamoDB users table.
     */
    const listPlatformUsers = new NodejsFunction(
      this,
      "ListPlatformUsersResolver",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: join(__dirname, "../lambda/users/listPlatformUsersResolver.ts"),
        handler: "handler",
        environment: {
          USERS_TABLE_NAME: props.usersTable.tableName,
          PLATFORM_ADMIN_USER_IDS: props.platformAdminUserIds.join(","),
          ALLOWED_ORIGINS: AllowedWebOrigins.join(","),
        },
      },
    );

    /**
     * Grant Table Read Permissions to ListPlatformUsers Lambda Function
     */
    props.usersTable.grantReadData(listPlatformUsers);

    /**
     * ListPlatformOrganizations Lambda Function
     *
     * This method is protected by the staff Cognito authorizer and will return
     * a list of all platform organizations.
     */
    const listPlatformOrganizations = new NodejsFunction(
      this,
      "ListPlatformOrganizationsResolver",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: join(
          __dirname,
          "../lambda/organizations/listPlatformOrganizationsResolver.ts",
        ),
        handler: "handler",
        environment: {
          ORGANIZATIONS_TABLE_NAME: props.organizationsTable.tableName,
          PLATFORM_ADMIN_USER_IDS: props.platformAdminUserIds.join(","),
          ALLOWED_ORIGINS: AllowedWebOrigins.join(","),
        },
      },
    );
    props.organizationsTable.grantReadData(listPlatformOrganizations);

    const managePlatformUser = new NodejsFunction(
      this,
      "ManagePlatformUserResolver",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: join(__dirname, "../lambda/users/managePlatformUserResolver.ts"),
        handler: "handler",
        environment: {
          USERS_TABLE_NAME: props.usersTable.tableName,
          STAFF_USER_POOL_ID: props.staffUserPool.userPoolId,
          PATIENT_USER_POOL_ID: props.patientUserPool.userPoolId,
          PLATFORM_ADMIN_USER_IDS: props.platformAdminUserIds.join(","),
          ALLOWED_ORIGINS: AllowedWebOrigins.join(","),
        },
      },
    );
    props.usersTable.grantReadWriteData(managePlatformUser);
    managePlatformUser.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:ListUsers",
        ],
        resources: [
          props.staffUserPool.userPoolArn,
          props.patientUserPool.userPoolArn,
        ],
      }),
    );

    const managePlatformOrganization = new NodejsFunction(
      this,
      "ManagePlatformOrganizationResolver",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: join(
          __dirname,
          "../lambda/organizations/managePlatformOrganizationResolver.ts",
        ),
        handler: "handler",
        environment: {
          ORGANIZATIONS_TABLE_NAME: props.organizationsTable.tableName,
          PLATFORM_ADMIN_USER_IDS: props.platformAdminUserIds.join(","),
          ALLOWED_ORIGINS: AllowedWebOrigins.join(","),
        },
      },
    );
    props.organizationsTable.grantReadWriteData(managePlatformOrganization);

    /**
     * IAM Policies for CreateOrganization Lambda Function
     */
    createOrganization.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminDeleteUser"],
        resources: [props.staffUserPool.userPoolArn],
      }),
    );
    createOrganization.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:TransactWriteItems",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ],
        resources: [
          props.usersTable.tableArn,
          props.organizationsTable.tableArn,
          props.organizationMembershipsTable.tableArn,
        ],
      }),
    );

    /**
     * CreateOrganizationLocation Lambda Function
     *
     * This Lambda function is responsible for creating a new location for an
     * organization. It requires the user to be a platform admin or an admin of
     * the organization, and it creates a new location in the locations table.
     */
    const createOrganizationLocation = new NodejsFunction(
      this,
      "CreateOrganizationLocationResolver",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: join(
          __dirname,
          "../lambda/organizations/createOrganizationLocationResolver.ts",
        ),
        handler: "handler",
        description:
          "Lambda function to create a new location for an organization",
        environment: {
          ORGANIZATIONS_TABLE_NAME: props.organizationsTable.tableName,
          ORGANIZATION_MEMBERSHIPS_TABLE_NAME:
            props.organizationMembershipsTable.tableName,
          LOCATIONS_TABLE_NAME: props.locationsTable.tableName,
          ALLOWED_ORIGINS: AllowedWebOrigins.join(","),
        },
      },
    );

    /**
     * IAM Policies for CreateOrganizationLocation Lambda Function
     */
    createOrganizationLocation.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [
          props.organizationsTable.tableArn,
          props.organizationMembershipsTable.tableArn,
        ],
      }),
    );
    createOrganizationLocation.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem"],
        resources: [props.locationsTable.tableArn],
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
     * /staff/me/organizations Resource
     */
    const staffOrganizations = staffMe.addResource("organizations");

    /**
     * /organizations/{organizationId} Resource
     */
    const organizationResource = api.root
      .addResource("organizations")
      .addResource("{organizationId}");

    /**
     * /organizations/{organizationId}/staff and
     * /organizations/{organizationId}/locations Resources
     */
    const organizationStaff = organizationResource.addResource("staff");
    const organizationLocations = organizationResource.addResource("locations");

    /**
     * /platform/organizations Resource and
     * /platform/users Resource
     */
    const platform = api.root.addResource("platform");
    const platformUsers = platform.addResource("users");
    const platformOrganizations = platform.addResource("organizations");
    const platformUser = platformUsers.addResource("{userId}");
    const platformOrganization = platformOrganizations.addResource(
      "{organizationId}",
    );

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
     * GET /staff/me/organizations Method
     *
     * This method is protected by the staff Cognito authorizer and will return
     * the organizations and locations that the authenticated staff member is
     * associated with.
     */
    staffOrganizations.addMethod(
      "GET",
      new apigateway.LambdaIntegration(getStaffOrganizations),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );

    /**
     * POST /platform/organizations Method
     *
     * This method is protected by the staff Cognito authorizer and will allow
     * platform admins to create new organizations. The Lambda function will
     * handle the creation of the organization and the initial admin user.
     */
    platformOrganizations.addMethod(
      "POST",
      new apigateway.LambdaIntegration(createOrganization),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );

    /**
     * GET /platform/organizations Method
     *
     * This method is protected by the staff Cognito authorizer and will return
     * a list of all platform organizations.
     */
    platformOrganizations.addMethod(
      "GET",
      new apigateway.LambdaIntegration(listPlatformOrganizations),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );

    /**
     * GET /platform/users Method
     *
     * This method is protected by the staff Cognito authorizer and will return
     * a list of all platform users.
     */
    platformUsers.addMethod(
      "GET",
      new apigateway.LambdaIntegration(listPlatformUsers),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );
    platformUsers.addMethod(
      "POST",
      new apigateway.LambdaIntegration(managePlatformUser),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );
    platformUser.addMethod(
      "GET",
      new apigateway.LambdaIntegration(managePlatformUser),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );
    platformUser.addMethod(
      "PATCH",
      new apigateway.LambdaIntegration(managePlatformUser),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );
    platformUser.addMethod(
      "DELETE",
      new apigateway.LambdaIntegration(managePlatformUser),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );
    platformOrganization.addMethod(
      "GET",
      new apigateway.LambdaIntegration(managePlatformOrganization),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );
    platformOrganization.addMethod(
      "PATCH",
      new apigateway.LambdaIntegration(managePlatformOrganization),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );
    platformOrganization.addMethod(
      "DELETE",
      new apigateway.LambdaIntegration(managePlatformOrganization),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );

    /**
     * POST /organizations/{organizationId}/locations Method
     *
     * This method is protected by the staff Cognito authorizer and will allow
     * staff members to create new locations within an organization. The Lambda
     * function will handle the creation of the location.
     */
    organizationLocations.addMethod(
      "POST",
      new apigateway.LambdaIntegration(createOrganizationLocation),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: staffAuthorizer,
      },
    );

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
