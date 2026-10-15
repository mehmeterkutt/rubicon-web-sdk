// Privacy controls (step 6.5): the port of the Android `internal/privacy` package, with the consent
// cookie as the authority and the refused state of Web Logging 4 (Web Privacy 1 to 3).
export {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_VERSION,
  consentCookieName,
  decodeConsentCookie,
  encodeConsentCookie,
} from './consent-cookie';
export { ConsentController } from './consent-controller';
export type { ConsentControllerOptions, ConsentState } from './consent-controller';
export { Privacy } from './privacy';
export type { PrivacyOptions } from './privacy';
