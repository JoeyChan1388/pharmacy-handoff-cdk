# Pharmacy Handoff CDK

The app defines project-prefixed Auth, Data, and API stacks. The Data stack
contains user, organization, location, organization membership, and
staff-location assignment tables.

## Organization Data Model

An organization represents the pharmacy company; a location represents one
branch belonging to it. The `Locations` table uses `organizationId` as its
partition key and `locationId` as its sort key, so all branches for an
organization can be queried together. Use globally unique IDs such as UUIDs
for locations.

The `StaffLocationAssignments` table uses `userId` as its partition key and
`locationId` as its sort key. Each item should also include `organizationId`
and assignment metadata such as active status. This supports listing a staff
member's locations by `userId`, and listing staff at a location through the
`ByLocation` index. A staff member can have assignments at multiple locations.

The `OrganizationMemberships` table uses `organizationId` as its partition key
and `userId` as its sort key. Store an organization-scoped `role` on each item:
`STAFF` for a regular staff member and `ADMIN` for someone who manages the whole
organization. Its `ByUser` index lists the organizations a user belongs to. A
staff member with role `STAFF` gets access through their location assignments;
an `ADMIN` gets organization-wide management permissions. The same person can
have different roles in different organizations.

For example, a location item can have `organizationId: "shoppers"` and
`locationId: "<location-uuid>"`; the matching assignment item contains that
same `organizationId` and `locationId` plus the staff member's Cognito `sub` as
`userId`. The corresponding membership item has the same `organizationId`,
`userId`, and a `role` value. API operations must verify that the organization,
location, and staff user exist, that the location belongs to the organization,
and that the caller's membership role permits the requested action. Never trust
a role or organization ID supplied by the client without checking these records.

## Useful commands

* `npm run build` compiles TypeScript
* `npm run test` runs tests
* `cdk deploy --all --profile personal` deploys all stacks
* `cdk diff --all --profile personal` compares all stacks with AWS
* `cdk synth` emits the CloudFormation templates

## Profile API

The API stack provides two Cognito-protected endpoints:

* `GET /staff/me` accepts a token from the staff user pool.
* `GET /staff/me/organizations` accepts a token from the staff user pool and
	returns the caller's active organization memberships and available locations.
* `GET /patient/me` accepts a token from the patient user pool.

Both return the caller's profile, selected by the authenticated token's `sub`
claim. They do not accept a user ID from the request. A missing profile returns
`404`; API Gateway rejects missing or invalid Cognito tokens. Browser CORS is
restricted to the origins configured in `api-stack.ts`.

The organizations endpoint gets the user's identity from the verified Cognito
`sub`. It returns only active memberships. Organization admins receive all
locations in each organization; regular staff receive only locations with an
active assignment. Example response:

```json
{
	"organizations": [
		{
			"organizationId": "shoppers-drug-mart",
			"name": "Shoppers Drug Mart",
			"role": "ADMIN",
			"locations": [
				{
					"locationId": "oshawa",
					"name": "Shoppers Drug Mart - Oshawa",
					"city": "Oshawa",
					"province": "ON"
				}
			]
		}
	]
}
```

After deploying, retrieve the API base URL from the `ApiUrl` output on the
`PharmacyHandoffApi` stack, then append the endpoint path and send the Cognito
JWT in an `Authorization: Bearer <token>` header.

## Postman Cognito Login

The staff user pool has a Cognito Hosted UI domain configured for Postman's
OAuth 2.0 Authorization Code flow with PKCE. In Postman, use:

* Grant Type: Authorization Code (With PKCE)
* Callback URL: `https://oauth.pstmn.io/v1/callback`
* Auth URL: `https://pharmacy-handoff-543908652237.auth.ca-central-1.amazoncognito.com/oauth2/authorize`
* Access Token URL: `https://pharmacy-handoff-543908652237.auth.ca-central-1.amazoncognito.com/oauth2/token`
* Client ID: `4f5n93ojg0sn2v29lg6u9b5jbe`
* Client Authentication: Send client credentials in body / no client secret
* Scopes: `openid email profile`

After Postman signs in, use the **ID token** from the Cognito token response as
the Bearer token for API Gateway requests. Cognito returns both an access token
and an ID token; the current API Gateway authorizers expect the ID token.

Organization admins can invite staff with:

```http
POST /organizations/{organizationId}/staff
Authorization: Bearer <staff-pool-id-token>
Content-Type: application/json

{
	"email": "new.staff@example.com",
	"locationIds": ["oshawa"]
}
```

The route requires a staff-pool token, and the handler additionally verifies
that its `sub` has an active `ADMIN` membership in the path organization. It
checks that every requested location belongs to that organization, creates or
reuses the Cognito staff account, and records a `STAFF` membership and location
assignments. New accounts receive a Cognito invitation and remain `INVITED`
until they finish setting their password. The invitation endpoint is currently
CORS-enabled for `http://localhost:3000`; change that origin in `api-stack.ts`
when configuring the deployed frontend domain.

## Cognito Profile Integration Test

This opt-in test creates a unique patient account, confirms and authenticates
it through Cognito SRP, verifies `GET /patient/me` returns the profile, checks
the DynamoDB record, and deletes both temporary records. It sends a sign-up
verification email to a unique plus-address based on `TEST_EMAIL`; use a
disposable or catch-all inbox. The test requires AWS credentials with permission
to sign up/confirm/delete users and read/delete items from the users table.

1. Copy `.env.example` to `.env` and set the deployed patient pool ID, app client
	ID, users table name, API base URL, region, AWS profile, and disposable
	`TEST_EMAIL`.
2. Review the values and run:

```sh
npm run test:profile-flow -- --confirm
```

The explicit `--confirm` flag is required because the script changes AWS
resources. `.env` is ignored by Git; do not put AWS access keys in it.

## Seed Organization

To create or update the example Shoppers Drug Mart organization, its Oshawa
location, and an organization-admin staff account, set the staff pool ID and
table names in `.env`. Set `AWS_REGION` to the Region containing the deployed
staff pool and tables, and set `SEED_ADMIN_EMAIL` to the admin's email address.
The script creates a Cognito staff user and sends an invitation if the user
does not already exist. The user must use that invitation to set a permanent
password. The seed can be rerun safely; it upserts the same organization,
location, staff user profile, and membership records.

```sh
npm run seed:organization -- --confirm
```

The example location has only city and province set; add a real street address
once you identify the specific Oshawa pharmacy branch.
