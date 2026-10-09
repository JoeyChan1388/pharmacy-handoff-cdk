/**
 * Cognito Authorizer Claims
 *
 * This interface represents the claims that can be extracted from a Cognito
 * authorizer event. The `sub` claim is the unique identifier for the user.
 */
export interface CognitoAuthorizerClaims {
  claims?: {
    sub?: string;
  };
}

/**
 * InviteOrganizationStaffRequest
 *
 * This interface represents the expected structure of the request body for
 * inviting a staff member to an organization. It includes the email of the
 * staff member and an array of location IDs they should be associated with.
 */
export interface InviteOrganizationStaffRequest {
  email?: unknown;
  locationIds?: unknown;
}

/**
 * CognitoUserAttribute
 *
 * This interface represents a user attribute in Cognito.
 */
export interface CognitoUserAttribute {
  Name?: string;
  Value?: string;
}