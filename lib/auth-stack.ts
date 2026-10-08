import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cognitoIdentityPool from "aws-cdk-lib/aws-cognito-identitypool";

/**
 * AuthStack
 *
 * This stack is responsible for creating the Cognito resources.
 */
export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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
  }
}
