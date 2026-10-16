import * as cdk from "aws-cdk-lib/core";

import { ApiStack } from "../lib/api-stack";
import { AuthStack } from "../lib/auth-stack";
import { DataStack } from "../lib/data-stack";

import { describe, expect, test } from "@jest/globals";
import { Match, Template } from "aws-cdk-lib/assertions";

describe("AuthStack", () => {
  const app = new cdk.App();
  const dataStack = new DataStack(app, "PharmacyHandoffData");
  const stack = new AuthStack(app, "PharmacyHandoffAuth", {
    usersTable: dataStack.usersTable,
  });
  const template = Template.fromStack(stack);

  test("creates staff and patient user pools with their intended sign-up settings", () => {
    template.resourceCountIs("AWS::Cognito::UserPool", 2);

    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "PharmacyHandoffAuth-StaffUserPool",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: true,
      },
    });

    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "PharmacyHandoffAuth-PatientUserPool",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: false,
      },
    });
  });

  test("creates public clients for both user pools", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 2);
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      UserPoolId: Match.anyValue(),
    });
  });

  test("configures staff Hosted UI for Postman authorization-code PKCE", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
      Domain: "pharmacy-handoff-543908652237",
      UserPoolId: Match.anyValue(),
    });

    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid", "email", "profile"],
      CallbackURLs: ["https://oauth.pstmn.io/v1/callback"],
      LogoutURLs: ["https://oauth.pstmn.io/v1/callback"],
    });
  });

  test("creates authenticated-only identity pools", () => {
    template.resourceCountIs("AWS::Cognito::IdentityPool", 2);

    template.hasResourceProperties("AWS::Cognito::IdentityPool", {
      IdentityPoolName: "PharmacyHandoffAuth-StaffIdentityPool",
      AllowUnauthenticatedIdentities: false,
    });

    template.hasResourceProperties("AWS::Cognito::IdentityPool", {
      IdentityPoolName: "PharmacyHandoffAuth-PatientIdentityPool",
      AllowUnauthenticatedIdentities: false,
    });
  });

  test("bundles the post-confirmation handler for Node.js 24", () => {
    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Handler: "index.handler",
    });
  });

  test("passes the users table name and grants the Lambda write access", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          USERS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:UpdateItem"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });
});

describe("DataStack", () => {
  const app = new cdk.App();
  const stack = new DataStack(app, "PharmacyHandoffData");
  const template = Template.fromStack(stack);

  test("creates all data tables with on-demand billing", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 5);

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "PharmacyHandoffData-UsersTable",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "userId", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
    });

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "PharmacyHandoffData-OrganizationsTable",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "organizationId", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "organizationId", KeyType: "HASH" }],
    });

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "PharmacyHandoffData-LocationsTable",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "organizationId", AttributeType: "S" },
        { AttributeName: "locationId", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "organizationId", KeyType: "HASH" },
        { AttributeName: "locationId", KeyType: "RANGE" },
      ],
    });

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "PharmacyHandoffData-StaffLocationAssignmentsTable",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "userId", AttributeType: "S" },
        { AttributeName: "locationId", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "userId", KeyType: "HASH" },
        { AttributeName: "locationId", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "ByLocation",
          KeySchema: [
            { AttributeName: "locationId", KeyType: "HASH" },
            { AttributeName: "userId", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    });

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "PharmacyHandoffData-OrganizationMembershipsTable",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "organizationId", AttributeType: "S" },
        { AttributeName: "userId", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "organizationId", KeyType: "HASH" },
        { AttributeName: "userId", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "ByUser",
          KeySchema: [
            { AttributeName: "userId", KeyType: "HASH" },
            { AttributeName: "organizationId", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    });
  });

  test("retains both tables when the stack is deleted or replaced", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        TableName: "PharmacyHandoffData-UsersTable",
      }),
    });

    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        TableName: "PharmacyHandoffData-OrganizationsTable",
      }),
    });

    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        TableName: "PharmacyHandoffData-LocationsTable",
      }),
    });

    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        TableName: "PharmacyHandoffData-StaffLocationAssignmentsTable",
      }),
    });

    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        TableName: "PharmacyHandoffData-OrganizationMembershipsTable",
      }),
    });
  });
});

describe("ApiStack", () => {
  const app = new cdk.App();
  const dataStack = new DataStack(app, "ApiTestData");
  const authStack = new AuthStack(app, "ApiTestAuth", {
    usersTable: dataStack.usersTable,
  });
  const apiStack = new ApiStack(app, "ApiTestApi", {
    usersTable: dataStack.usersTable,
    organizationsTable: dataStack.organizationsTable,
    locationsTable: dataStack.locationsTable,
    staffLocationAssignmentsTable: dataStack.staffLocationAssignmentsTable,
    organizationMembershipsTable: dataStack.organizationMembershipsTable,
    platformAdminUserIds: ["platform-admin-sub"],
    staffUserPool: authStack.staffUserPool,
    patientUserPool: authStack.patientUserPool,
  });
  const template = Template.fromStack(apiStack);

  test("defines separate Cognito authorizers for staff and patients", () => {
    template.resourceCountIs("AWS::ApiGateway::Authorizer", 2);
    template.hasResourceProperties("AWS::ApiGateway::Authorizer", {
      Type: "COGNITO_USER_POOLS",
      ProviderARNs: Match.anyValue(),
    });
  });

  test("exposes five authenticated GET endpoints", () => {
    const methods = Object.values(
      template.findResources("AWS::ApiGateway::Method"),
    ).filter(
      (method) =>
        (method.Properties as { HttpMethod?: string }).HttpMethod === "GET",
    );

    expect(methods).toHaveLength(7);
    const authorizerIds = new Set<string>();
    for (const method of methods) {
      const properties = method.Properties as {
        AuthorizationType?: string;
        AuthorizerId?: unknown;
      };
      expect(properties.AuthorizationType).toBe("COGNITO_USER_POOLS");
      expect(properties.AuthorizerId).toBeDefined();
      authorizerIds.add(JSON.stringify(properties.AuthorizerId));
    }
    expect(authorizerIds.size).toBe(2);
  });

  test("uses one profile Lambda with read-only access to the users table", () => {
    template.resourceCountIs("AWS::Lambda::Function", 9);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Handler: "index.handler",
      Environment: {
        Variables: {
          USERS_TABLE_NAME: Match.anyValue(),
          ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
        },
      },
    });

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "dynamodb:GetItem",
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  test("creates a staff-authenticated organizations and locations endpoint", () => {
    const getMethods = Object.values(
      template.findResources("AWS::ApiGateway::Method"),
    ).filter(
      (method) =>
        (method.Properties as { HttpMethod?: string }).HttpMethod === "GET",
    );
    expect(getMethods).toHaveLength(7);
    expect(
      getMethods.every(
        (method) =>
          (method.Properties as { AuthorizationType?: string })
            .AuthorizationType === "COGNITO_USER_POOLS",
      ),
    ).toBe(true);

    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          ORGANIZATIONS_TABLE_NAME: Match.anyValue(),
          LOCATIONS_TABLE_NAME: Match.anyValue(),
          ORGANIZATION_MEMBERSHIPS_TABLE_NAME: Match.anyValue(),
          STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:Query"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  test("creates an organization staff invitation endpoint protected by staff Cognito", () => {
    const postMethods = Object.values(
      template.findResources("AWS::ApiGateway::Method"),
    ).filter(
      (method) =>
        (method.Properties as { HttpMethod?: string }).HttpMethod === "POST",
    );

    expect(postMethods).toHaveLength(4);
    for (const method of postMethods) {
      expect(method.Properties).toMatchObject({
        AuthorizationType: "COGNITO_USER_POOLS",
      });
      expect(
        (method.Properties as { AuthorizerId?: unknown }).AuthorizerId,
      ).toBeDefined();
    }
  });

  test("creates an allowlisted platform-admin organization endpoint", () => {
    template.resourceCountIs("AWS::Lambda::Function", 9);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          PLATFORM_ADMIN_USER_IDS: "platform-admin-sub",
          STAFF_USER_POOL_ID: Match.anyValue(),
        }),
      },
    });

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "cognito-idp:AdminCreateUser",
              "cognito-idp:AdminDeleteUser",
            ]),
            Effect: "Allow",
            Resource: Match.anyValue(),
          }),
          Match.objectLike({
            Action: Match.arrayWith([
              "dynamodb:TransactWriteItems",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
            ]),
            Effect: "Allow",
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
  });

  test("creates platform-admin list resolvers with table scan access", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          USERS_TABLE_NAME: Match.anyValue(),
          PLATFORM_ADMIN_USER_IDS: "platform-admin-sub",
        }),
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          ORGANIZATIONS_TABLE_NAME: Match.anyValue(),
          PLATFORM_ADMIN_USER_IDS: "platform-admin-sub",
        }),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:Scan"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  test("protects all platform CRUD methods and grants Cognito pool access", () => {
    const methods = Object.values(
      template.findResources("AWS::ApiGateway::Method"),
    );
    const platformCrudMethods = methods.filter((method) => {
      const properties = method.Properties as {
        HttpMethod?: string;
        AuthorizationType?: string;
      };
      return ["GET", "POST", "PATCH", "DELETE"].includes(
        properties.HttpMethod ?? "",
      ) && properties.AuthorizationType === "COGNITO_USER_POOLS";
    });
    expect(platformCrudMethods.length).toBeGreaterThanOrEqual(13);

    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          STAFF_USER_POOL_ID: Match.anyValue(),
          PATIENT_USER_POOL_ID: Match.anyValue(),
          PLATFORM_ADMIN_USER_IDS: "platform-admin-sub",
        }),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "cognito-idp:AdminCreateUser",
              "cognito-idp:AdminDisableUser",
              "cognito-idp:AdminEnableUser",
              "cognito-idp:AdminUpdateUserAttributes",
              "cognito-idp:ListUsers",
            ]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  test("creates an organization location endpoint with scoped table access", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          ORGANIZATION_MEMBERSHIPS_TABLE_NAME: Match.anyValue(),
          ORGANIZATIONS_TABLE_NAME: Match.anyValue(),
          LOCATIONS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "dynamodb:GetItem",
            Effect: "Allow",
          }),
          Match.objectLike({
            Action: "dynamodb:PutItem",
            Effect: "Allow",
            Resource: Match.objectLike({
              "Fn::ImportValue": Match.stringLikeRegexp("LocationsTable"),
            }),
          }),
        ]),
      },
    });
  });

  test("gives the invite Lambda scoped Cognito and table permissions", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          STAFF_USER_POOL_ID: Match.anyValue(),
          ORGANIZATION_MEMBERSHIPS_TABLE_NAME: Match.anyValue(),
          STAFF_LOCATION_ASSIGNMENTS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "cognito-idp:AdminCreateUser",
              "cognito-idp:AdminGetUser",
            ]),
            Effect: "Allow",
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "dynamodb:UpdateItem",
            Effect: "Allow",
            Resource: Match.objectLike({
              "Fn::ImportValue": Match.stringLikeRegexp(
                "StaffLocationAssignmentsTable",
              ),
            }),
          }),
        ]),
      },
    });
  });
});
