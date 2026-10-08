import * as cdk from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, test } from "@jest/globals";
import { AuthStack } from "../lib/auth-stack";
import { DataStack } from "../lib/data-stack";

describe("AuthStack", () => {
	const app = new cdk.App();
	const stack = new AuthStack(app, "PharmacyHandoffAuth");
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
});

describe("DataStack", () => {
	const app = new cdk.App();
	const stack = new DataStack(app, "PharmacyHandoffData");
	const template = Template.fromStack(stack);

	test("creates the users and organizations tables with on-demand billing", () => {
		template.resourceCountIs("AWS::DynamoDB::Table", 2);

		template.hasResourceProperties("AWS::DynamoDB::Table", {
			TableName: "PharmacyHandoffData-UsersTable",
			BillingMode: "PAY_PER_REQUEST",
			AttributeDefinitions: [
				{ AttributeName: "userId", AttributeType: "S" },
			],
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
	});
});
