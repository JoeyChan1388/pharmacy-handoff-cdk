# Pharmacy Handoff CDK

The app defines project-prefixed Auth, Data, and API stacks. The Data stack
contains user, organization, location, and staff-location assignment tables.

## Organization Data Model

An organization represents the pharmacy company; a location represents one
branch belonging to it. The `Locations` table uses `organizationId` as its
partition key and `locationId` as its sort key, so all branches for an
organization can be queried together. Use globally unique IDs such as UUIDs
for locations.

The `StaffLocationAssignments` table uses `userId` as its partition key and
`locationId` as its sort key. Each item should also include `organizationId`
and any assignment metadata, such as a role or active status. This supports
listing a staff member's locations by `userId`, and listing staff at a location
through the `ByLocation` index. A staff member can have assignments at multiple
locations, including locations under different organizations if the business
rules allow it.

For example, a location item can have `organizationId: "shoppers"` and
`locationId: "<location-uuid>"`; the matching assignment item contains that
same `organizationId` and `locationId` plus the staff member's Cognito `sub` as
`userId`. API operations that create assignments should verify that the
organization, location, and staff user exist and that the location belongs to
the specified organization.

## Useful commands

* `npm run build` compiles TypeScript
* `npm run test` runs tests
* `cdk deploy --all --profile personal` deploys both stacks
* `cdk diff --all --profile personal` compares both stacks with AWS
* `cdk synth` emits the CloudFormation templates

## Profile API

The API stack provides two Cognito-protected endpoints:

* `GET /staff/me` accepts a token from the staff user pool.
* `GET /patient/me` accepts a token from the patient user pool.

Both return the caller's profile, selected by the authenticated token's `sub`
claim. They do not accept a user ID from the request. A missing profile returns
`404`; API Gateway rejects missing or invalid Cognito tokens. The API allows
browser requests from any origin; authorization is still enforced by Cognito.

After deploying, retrieve the API base URL from the `ApiUrl` output on the
`PharmacyHandoffApi` stack, then append the endpoint path and send the Cognito
JWT in an `Authorization: Bearer <token>` header.

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
