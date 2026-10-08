import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const requiredEnvironment = [
  "AWS_REGION",
  "STAFF_USER_POOL_ID",
  "USERS_TABLE_NAME",
  "ORGANIZATIONS_TABLE_NAME",
  "LOCATIONS_TABLE_NAME",
  "ORGANIZATION_MEMBERSHIPS_TABLE_NAME",
  "SEED_ADMIN_EMAIL",
];

for (const key of requiredEnvironment) {
  if (!process.env[key] || process.env[key].includes("example")) {
    throw new Error(`Set ${key} to a real value in the root .env file`);
  }
}

if (!process.argv.includes("--confirm")) {
  throw new Error(
    "This script creates or updates AWS resources. Review the target settings, then rerun with --confirm.",
  );
}

const region = process.env.AWS_REGION;
const staffUserPoolId = process.env.STAFF_USER_POOL_ID;
const usersTable = process.env.USERS_TABLE_NAME;
const organizationsTable = process.env.ORGANIZATIONS_TABLE_NAME;
const locationsTable = process.env.LOCATIONS_TABLE_NAME;
const membershipsTable = process.env.ORGANIZATION_MEMBERSHIPS_TABLE_NAME;
const adminEmail = process.env.SEED_ADMIN_EMAIL.trim().toLowerCase();
const organizationId = process.env.SEED_ORGANIZATION_ID ?? "shoppers-drug-mart";
const organizationName =
  process.env.SEED_ORGANIZATION_NAME ?? "Shoppers Drug Mart";
const locationId = process.env.SEED_LOCATION_ID ?? "oshawa";
const locationName = process.env.SEED_LOCATION_NAME ?? "Shoppers Drug Mart - Oshawa";
const now = new Date().toISOString();

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
  throw new Error("SEED_ADMIN_EMAIL must be a valid email address");
}

const cognito = new CognitoIdentityProviderClient({ region });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

async function getOrCreateAdmin() {
  try {
    return await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: staffUserPoolId,
        Username: adminEmail,
      }),
    );
  } catch (error) {
    if (error.name !== "UserNotFoundException") throw error;
  }

  const createdUser = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: staffUserPoolId,
      Username: adminEmail,
      UserAttributes: [{ Name: "email", Value: adminEmail }],
      DesiredDeliveryMediums: ["EMAIL"],
    }),
  );

  console.log("Created Cognito staff user and sent an invitation email.");
  return createdUser.User;
}

const admin = await getOrCreateAdmin();
const adminSub = admin?.Attributes?.find(({ Name }) => Name === "sub")?.Value;

if (!adminSub) {
  throw new Error("Cognito staff user does not have a sub attribute");
}

async function upsert(tableName, key, attributes) {
  const expressionNames = { "#createdAt": "createdAt", "#updatedAt": "updatedAt" };
  const expressionValues = { ":createdAt": now, ":updatedAt": now };
  const updates = [
    "#createdAt = if_not_exists(#createdAt, :createdAt)",
    "#updatedAt = :updatedAt",
  ];

  for (const [attribute, value] of Object.entries(attributes)) {
    const nameToken = `#${attribute}`;
    const valueToken = `:${attribute}`;
    expressionNames[nameToken] = attribute;
    expressionValues[valueToken] = value;
    updates.push(`${nameToken} = ${valueToken}`);
  }

  await dynamodb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${updates.join(", ")}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
    }),
  );
}

await upsert(
  organizationsTable,
  { organizationId },
  { name: organizationName },
);
await upsert(usersTable, { userId: adminSub }, { email: adminEmail });
await upsert(
  locationsTable,
  { organizationId, locationId },
  {
    name: locationName,
    city: "Oshawa",
    province: "ON",
  },
);
await upsert(
  membershipsTable,
  { organizationId, userId: adminSub },
  {
    email: adminEmail,
    role: "ADMIN",
    status: "ACTIVE",
  },
);

console.log("Seed completed:");
console.log(`- Organization: ${organizationName} (${organizationId})`);
console.log(`- Location: ${locationName} (${locationId}), Oshawa, ON`);
console.log(`- Organization membership: ADMIN (${adminSub})`);
if (admin.UserStatus === "FORCE_CHANGE_PASSWORD") {
  console.log("The admin must use the invitation email to set a permanent password.");
}