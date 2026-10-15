// Identity and super properties (step 6.1): the port of the Android `internal/identity` package over
// the identity cookie and its `localStorage` mirrors (Web Identity 1 to 4, Web Session 5).
export {
  decodeIdentityCookie,
  encodeIdentityCookie,
  IDENTITY_COOKIE_MAX_AGE_SECONDS,
  IDENTITY_COOKIE_VERSION,
  identityCookieName,
  isDeviceId,
  isValidUserId,
  MAX_USER_ID_LENGTH,
} from './identity-cookie';
export type { IdentityCookieValue } from './identity-cookie';
export { FIRST_VISIT_RACE_MS, IDENTITY_MATRIX, Identity } from './identity';
export type {
  IdentifyDecision,
  IdentityCell,
  IdentityMatrixRow,
  IdentityOptions,
  IdentityOutcome,
  IdentitySnapshot,
  IdentitySource,
} from './identity';
