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

## Platform Organization Provisioning

`POST /platform/organizations` provisions a new blank organization and invites
its first organization admin. It is not public self-signup: API Gateway first
requires a valid staff-pool Cognito token, then the Lambda requires the token's
`sub` to be in the platform-admin allowlist. The allowlist is configured in
`bin/pharmacy-handoff-cdk.ts` from the `platformAdminUserIds` CDK context value,
the `PLATFORM_ADMIN_USER_IDS` environment variable, or the current seeded admin
as the personal-project default. Supply comma-separated Cognito `sub` values
to override it, for example:

```sh
PLATFORM_ADMIN_USER_IDS="cognito-sub-1,cognito-sub-2" cdk deploy PharmacyHandoffApi --profile personal
```

The request body contains the organization name and the initial admin's email:

```json
{
	"organizationName": "New Pharmacy Group",
	"adminEmail": "admin@example.com"
}
```

The endpoint generates an organization ID, creates no locations, sends the
admin a Cognito invitation, and creates an `ADMIN` membership with status
`INVITED` until the invitee sets a permanent password. DynamoDB writes for the
organization, profile, and membership are transactional.

Platform admins can use `GET /platform/users` and
`GET /platform/organizations` to retrieve all user profiles or organizations.
Both endpoints require a staff-pool Cognito ID token and verify that its `sub`
is in the platform-admin allowlist. Responses contain a `users` or
`organizations` array, respectively; each endpoint scans all DynamoDB pages.

The remaining platform CRUD routes are:

* `POST /platform/users` creates a Cognito account and profile. The JSON body
	requires `email` and `userPoolType` (`STAFF` or `PATIENT`); `givenName` and
	`familyName` are optional.
* `GET /platform/users/{userId}` retrieves one profile. `PATCH` accepts any of
	`email`, `givenName`, `familyName`, or `status` (`ACTIVE` or `DISABLED`).
	`DELETE` disables the Cognito account and marks its profile `DISABLED`.
* `GET /platform/organizations/{organizationId}` retrieves one organization.
	`PATCH` accepts `name` and/or `status` (`ACTIVE` or `INACTIVE`). `DELETE`
	marks the organization `INACTIVE`; only a platform admin can reactivate it
	with `PATCH`, organization admins cannot.

All of these routes require the staff-pool ID token and platform-admin
allowlist check. Deactivated organizations remain visible in platform lists,
but are omitted from staff organization results and reject new invitations or
locations. Organization memberships, locations, and assignments are retained.

## Useful commands

* `npm run verify` runs lint, format check, build, tests, and synth (same as CI)
* `npm run lint:fix` sorts imports and class members into the house style
* `npm run format` runs Prettier on all source
* `npm run test` runs tests
* `cdk deploy --all --profile personal` deploys all stacks
* `cdk diff --all --profile personal` compares all stacks with AWS
* `cdk synth` emits the CloudFormation templates

## Profile API

The API stack provides these Cognito-protected profile endpoints:

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

Active organization members can retrieve details with
`GET /organizations/{organizationId}/details`. Organization admins receive the
full roster and all locations, including each member's profile and membership
status, role, active location IDs, and location assignments. Regular staff
receive the organization record, their own membership/profile, and only their
active assigned locations; other members' profiles and assignments are not
returned. Inactive or invited memberships cannot access the endpoint.

Organization admins can update their organization with
`PATCH /organizations/{organizationId}/details` and a JSON body containing
`name` (1 to 120 characters). Only `name` is editable here.

Organization admins can soft-delete their organization with
`DELETE /organizations/{organizationId}/details`, which marks it `INACTIVE`.
Memberships, locations, and assignments are retained. Reactivating an
organization is reserved for platform admins.

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

Organization admins can create a location with:

```http
POST /organizations/{organizationId}/locations
Authorization: Bearer <staff-pool-id-token>
Content-Type: application/json

{
	"name": "Shoppers Drug Mart - Oshawa",
	"addressLine1": "123 Example Street",
	"city": "Oshawa",
	"province": "ON",
	"postalCode": "L1H 1A1",
	"phone": "+1-905-555-0100"
}
```

The handler verifies the caller has an active `ADMIN` membership for the
organization. `name`, `city`, and `province` are required; address and phone
fields are optional. The location ID is generated by the API.

Organization admins can list locations with
`GET /organizations/{organizationId}/locations`, retrieve one with
`GET /organizations/{organizationId}/locations/{locationId}`, and update a
location with `PATCH` on the item path. PATCH accepts any of `name`,
`addressLine1`, `addressLine2`, `city`, `province`, `postalCode`, `phone`, and
`status` (`ACTIVE` or `INACTIVE`). `DELETE` on the item path marks it inactive
and retains its record and assignments; it does not hard-delete data. The
organization must be active and the caller must have an active `ADMIN`
membership for all location operations.

## Contributing

CI runs `npm run verify` on every pull request. Run it locally before pushing.

Conventions the linter enforces, and the intent behind them:

* **One Lambda per resource.** Each resolver under `lambda/` owns every HTTP
	method for its resource and dispatches on `event.httpMethod`. Platform-admin
	resolvers live in `lambda/platform/`, organization-member resolvers in
	`lambda/organizations/`, and self-service ones in `lambda/users/`.
* **Handler shape.** Read config with a `loadConfig` helper, check auth, then
	`switch` on method into small `listX` / `getX` / `createX` / `updateX` /
	`deleteX` functions. Use `createUserProfileResolver.ts` as the reference.
* **Shared helpers first.** Membership and organization checks go through
	`loadOrganizationAccess`, update expressions through `buildUpdateExpression`,
	and body parsing through `parseJsonBody`. Add to `lambda/shared/` rather than
	re-implementing.
* **Imports and members sorted short to long**, grouped named, namespace, then
	type imports. `npm run lint:fix` does this for you.
* **JSDoc on everything exported or top-level.** A one-line title, a blank
	line, then a description. Use titled JSDoc blocks to mark stages inside long
	functions and `//` for one-line guards.
* **Soft deletes only.** `DELETE` sets `status` to `INACTIVE` or `DISABLED`;
	nothing is removed from DynamoDB or Cognito.
