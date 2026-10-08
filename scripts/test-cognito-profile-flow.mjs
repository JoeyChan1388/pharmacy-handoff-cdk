/**
 * This script tests the Cognito sign-up and profile flow for the patient 
 * user pool.
 *
 * It creates a temporary user, confirms the sign-up, and checks that a 
 * profile is written to DynamoDB.
 * 
 * After the test, it cleans up by deleting the user and profile.
 * 
 * To run this test, set the required environment variables in a .env file and
 * run the script with Node.js:
 * 
 *  node --env-file=.env scripts/test-cognito-profile-flow.mjs --confirm
 */

import { randomUUID } from "node:crypto";
import {
  AdminConfirmSignUpCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from "amazon-cognito-identity-js";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const requiredEnvironment = [
  "AWS_REGION",
  "PATIENT_USER_POOL_ID",
  "PATIENT_USER_POOL_CLIENT_ID",
  "USERS_TABLE_NAME",
  "API_BASE_URL",
  "TEST_EMAIL",
];

for (const key of requiredEnvironment) {
  if (
    !process.env[key] ||
    process.env[key].startsWith("your-") ||
    process.env[key].includes("example")
  ) {
    throw new Error(`Set ${key} to a real value in the root .env file`);
  }
}

if (!process.argv.includes("--confirm")) {
  throw new Error(
    "This test creates and deletes a Cognito user. Review the target settings, then rerun with --confirm.",
  );
}

const region = process.env.AWS_REGION;
const userPoolId = process.env.PATIENT_USER_POOL_ID;
const clientId = process.env.PATIENT_USER_POOL_CLIENT_ID;
const tableName = process.env.USERS_TABLE_NAME;
const apiBaseUrl = process.env.API_BASE_URL.replace(/\/+$/, "");
const runId = randomUUID();
const [emailName, emailDomain] = process.env.TEST_EMAIL.split("@");

if (
  !emailName ||
  !emailDomain ||
  process.env.TEST_EMAIL.split("@").length !== 2
) {
  throw new Error("TEST_EMAIL must be a valid email address");
}

const username = `${emailName}+pharmacy-handoff-${runId}@${emailDomain}`;
const password = `Tt9!${randomUUID()}aA`;
const cognito = new CognitoIdentityProviderClient({ region });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
let userSub;
let created = false;
let profileVerified = false;

try {
  const signUp = await cognito.send(
    new SignUpCommand({
      ClientId: clientId,
      Username: username,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: username },
        { Name: "given_name", Value: "Integration" },
        { Name: "family_name", Value: "Test" },
      ],
    }),
  );
  userSub = signUp.UserSub;
  created = true;

  if (!userSub) {
    throw new Error("Cognito sign-up did not return the new user's sub");
  }

  await cognito.send(
    new AdminConfirmSignUpCommand({
      UserPoolId: userPoolId,
      Username: username,
    }),
  );

  const userPool = new CognitoUserPool({
    UserPoolId: userPoolId,
    ClientId: clientId,
  });
  const cognitoUser = new CognitoUser({ Username: username, Pool: userPool });
  const session = await new Promise((resolve, reject) => {
    cognitoUser.authenticateUser(
      new AuthenticationDetails({ Username: username, Password: password }),
      {
        onSuccess: resolve,
        onFailure: reject,
        newPasswordRequired: () =>
          reject(new Error("Temporary test user unexpectedly requires a new password")),
      },
    );
  });
  const idToken = session.getIdToken().getJwtToken();

  const apiResponse = await fetch(`${apiBaseUrl}/patient/me`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const apiProfile = await apiResponse.json();

  if (apiResponse.status !== 200) {
    throw new Error(
      `GET /patient/me returned ${apiResponse.status}: ${JSON.stringify(apiProfile)}`,
    );
  }
  if (
    apiProfile.userId !== userSub ||
    apiProfile.email !== username ||
    apiProfile.givenName !== "Integration" ||
    apiProfile.familyName !== "Test"
  ) {
    throw new Error(
      `API profile contents did not match expected values: ${JSON.stringify(apiProfile)}`,
    );
  }
  console.log("GET /patient/me returned the expected profile");

  let profile;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await dynamodb.send(
      new GetCommand({
        TableName: tableName,
        Key: { userId: userSub },
        ConsistentRead: true,
      }),
    );
    profile = result.Item;
    if (profile) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!profile) {
    throw new Error(`No profile was written for Cognito sub ${userSub}`);
  }

  if (
    profile.userId !== userSub ||
    profile.email !== username ||
    profile.givenName !== "Integration" ||
    profile.familyName !== "Test"
  ) {
    throw new Error(
      `Profile contents did not match expected values: ${JSON.stringify(profile)}`,
    );
  }

  profileVerified = true;
  console.log(`Profile flow passed for Cognito sub ${userSub}`);
} finally {
  if (userSub) {
    await dynamodb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { userId: userSub },
      }),
    );
  }
  if (created) {
    await cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }),
    );
  }
  if (profileVerified) {
    console.log("Temporary Cognito user and DynamoDB profile cleaned up");
  }
}
