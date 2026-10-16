import { join } from "node:path";
import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cognitoIdentityPool from "aws-cdk-lib/aws-cognito-identitypool";

interface AuthStackProps extends cdk.StackProps {
  usersTable: dynamodb.ITable;
}

/**
 * AuthStack
 *
 * This stack is responsible for creating the Cognito resources.
 */
export class AuthStack extends cdk.Stack {
  public readonly staffUserPool: cognito.UserPool;
  public readonly patientUserPool: cognito.UserPool;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    /**
     * Staff User Pool
     */
    this.staffUserPool = new cognito.UserPool(this, "StaffUserPool", {
      userPoolName: `${id}-StaffUserPool`,
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
    });

    /**
     * Patient User Pool
     */
    this.patientUserPool = new cognito.UserPool(this, "PatientUserPool", {
      userPoolName: `${id}-PatientUserPool`,
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
    });

    /**
     * User Pool Clients
     */
    new cognito.UserPoolClient(this, "StaffUserPoolClient", {
      userPool: this.staffUserPool,
      generateSecret: false,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: ["https://oauth.pstmn.io/v1/callback"],
        logoutUrls: ["https://oauth.pstmn.io/v1/callback"],
      },
    });
    new cognito.UserPoolClient(this, "PatientUserPoolClient", {
      userPool: this.patientUserPool,
      generateSecret: false,
    });

    /**
     * User Pool Domains
     *
     * This domain is used for the hosted UI for staff (postman testing)
     */
    this.staffUserPool.addDomain("StaffHostedUiDomain", {
      cognitoDomain: {
        domainPrefix: "pharmacy-handoff-543908652237",
      },
    });

    /**
     * Identity Pools
     */
    new cognitoIdentityPool.IdentityPool(this, "StaffIdentityPool", {
      identityPoolName: `${id}-StaffIdentityPool`,
      allowUnauthenticatedIdentities: false,
    });
    new cognitoIdentityPool.IdentityPool(this, "PatientIdentityPool", {
      identityPoolName: `${id}-PatientIdentityPool`,
      allowUnauthenticatedIdentities: false,
    });

    /**
     * CreateUserProfileResolver
     *
     * This Lambda function will be responsible for creating user profiles
     * in the DynamoDB table when a new user is created in the Cognito
     * User Pool.
     */
    const createUserProfileResolver = new NodejsFunction(
      this,
      "CreateUserProfileResolver",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        entry: join(__dirname, "../lambda/auth/createUserProfileResolver.ts"),
        handler: "handler",
        description:
          "Creates a profile in the Users table after a user has confirmed their sign-up.",
        environment: {
          USERS_TABLE_NAME: props.usersTable.tableName,
        },
      },
    );
    props.usersTable.grantWriteData(createUserProfileResolver);

    /**
     * Attach the Lambda function to the PostConfirmation trigger of both
     * user pools.
     */
    this.staffUserPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      createUserProfileResolver,
    );
    this.patientUserPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      createUserProfileResolver,
    );
  }
}
