# Pharmacy Handoff CDK

The app defines project-prefixed Auth and Data stacks. The Data stack is ready
for future DynamoDB and S3 resources.

## Useful commands

* `npm run build` compiles TypeScript
* `npm run test` runs tests
* `cdk deploy --all --profile personal` deploys both stacks
* `cdk diff --all --profile personal` compares both stacks with AWS
* `cdk synth` emits the CloudFormation templates

## Cognito Profile Integration Test

This opt-in test creates a unique patient account, confirms it, verifies that
the post-confirmation Lambda wrote the profile to DynamoDB, and deletes both
temporary records. It sends a sign-up verification email to a unique plus-address
based on `TEST_EMAIL`; use a disposable or catch-all inbox. The test requires
AWS credentials with permission to sign up/confirm/delete users and read/delete
items from the users table.

1. Copy `.env.example` to `.env` and set the deployed patient pool ID, app client
	ID, users table name, region, AWS profile, and disposable `TEST_EMAIL`.
2. Review the values and run:

```sh
npm run test:profile-flow -- --confirm
```

The explicit `--confirm` flag is required because the script changes AWS
resources. `.env` is ignored by Git; do not put AWS access keys in it.
