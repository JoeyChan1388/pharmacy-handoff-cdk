import { randomUUID } from "node:crypto";
import {
	AdminConfirmSignUpCommand,
	AdminDeleteUserCommand,
	CognitoIdentityProviderClient,
	SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
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
	"TEST_EMAIL",
];

for (const key of requiredEnvironment) {
	if (!process.env[key] || process.env[key].startsWith("your-") || process.env[key].includes("example")) {
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
const runId = randomUUID();
const [emailName, emailDomain] = process.env.TEST_EMAIL.split("@");

if (!emailName || !emailDomain || process.env.TEST_EMAIL.split("@").length !== 2) {
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
		throw new Error(`Profile contents did not match expected values: ${JSON.stringify(profile)}`);
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