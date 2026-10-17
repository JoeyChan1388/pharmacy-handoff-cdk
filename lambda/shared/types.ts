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
 * CreateOrganizationRequest
 *
 * This interface represents the expected structure of the request body for
 * creating a new organization. It includes the name of the organization and
 * the email of the initial admin user.
 */
export interface CreateOrganizationRequest {
  adminEmail?: unknown;
  organizationName?: unknown;
}

/**
 * CreateOrganizationLocationRequest
 *
 * This interface represents the expected structure of the request body for
 * creating a new location within an organization. It includes the name,
 * address, city, province, postal code, and phone number of the location.
 */
export interface CreateOrganizationLocationRequest {
  name?: unknown;
  city?: unknown;
  phone?: unknown;
  province?: unknown;
  postalCode?: unknown;
  addressLine1?: unknown;
  addressLine2?: unknown;
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

/**
 * StaffOrganizationLocation
 *
 * This interface represents a location associated with a staff member within
 * an organization. It includes the location ID, name, city, province, and
 * status.
 */
export interface StaffOrganizationLocation {
  name?: string;
  city?: string;
  status?: string;
  province?: string;
  locationId: string;
}

/**
 * StaffOrganizationSummary
 *
 * This interface represents a summary of an organization that a staff member
 * is associated with. It includes the organization ID, name, role, and an
 * array of locations.
 */
export interface StaffOrganizationSummary {
  name?: string;
  organizationId: string;
  role: "ADMIN" | "STAFF";
  locations: StaffOrganizationLocation[];
}

/**
 * OrganizationMembership
 *
 * This interface represents a membership of a user in an organization. It
 * includes the organization ID, user ID, role, and status.
 */
export interface OrganizationMembership {
  userId: string;
  email?: string;
  status?: string;
  organizationId: string;
  role: "ADMIN" | "STAFF";
}

/**
 * StaffLocationAssignment
 *
 * This interface represents an assignment of a staff member to a specific
 * location within an organization. It includes the organization ID, location
 * ID, and status.
 */
export interface StaffLocationAssignment {
  status?: string;
  locationId: string;
  organizationId: string;
}

/**
 * OrganizationLocation
 *
 * A location record as stored in the locations table, keyed by organization.
 */
export interface OrganizationLocation extends StaffOrganizationLocation {
  organizationId: string;
}
