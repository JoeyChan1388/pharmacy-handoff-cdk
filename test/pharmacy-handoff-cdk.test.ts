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
        Variables: {
          USERS_TABLE_NAME: Match.anyValue(),
        },
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

  test("creates the user and organization tables with on-demand billing", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 4);

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

  test("exposes two authenticated GET endpoints", () => {
    const methods = Object.values(
      template.findResources("AWS::ApiGateway::Method"),
    ).filter(
      (method) =>
        (method.Properties as { HttpMethod?: string }).HttpMethod === "GET",
    );

    expect(methods).toHaveLength(2);
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
    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Handler: "index.handler",
      Environment: {
        Variables: {
          USERS_TABLE_NAME: Match.anyValue(),
        },
      },
    });

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:GetItem"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });
});
