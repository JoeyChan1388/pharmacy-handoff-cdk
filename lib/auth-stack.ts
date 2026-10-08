import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { join } from "node:path";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cognitoIdentityPool from "aws-cdk-lib/aws-cognito-identitypool";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

interface AuthStackProps extends cdk.StackProps {
  usersTable: dynamodb.ITable;
}

/**
 * AuthStack
 *
 * This stack is responsible for creating the Cognito resources.
 */
export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const staffUserPool = new cognito.UserPool(this, "StaffUserPool", {
      userPoolName: `${id}-StaffUserPool`,
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
    });

    const patientUserPool = new cognito.UserPool(this, "PatientUserPool", {
      userPoolName: `${id}-PatientUserPool`,
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
    });

    new cognito.UserPoolClient(this, "StaffUserPoolClient", {
      userPool: staffUserPool,
      generateSecret: false,
    });

    new cognito.UserPoolClient(this, "PatientUserPoolClient", {
      userPool: patientUserPool,
      generateSecret: false,
    });

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
    const createUserProfileResolver = new NodejsFunction(this, "CreateUserProfileResolver", {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: join(__dirname, "../lambda/createUserProfileResolver.ts"),
      handler: "handler",
      environment: {
        USERS_TABLE_NAME: props.usersTable.tableName,
      },
    });
    props.usersTable.grantWriteData(createUserProfileResolver);

    /**
    * Attach the Lambda function to the PostConfirmation trigger of both
     * user pools.
     */
    staffUserPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, createUserProfileResolver);
    patientUserPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, createUserProfileResolver);
  }
}
