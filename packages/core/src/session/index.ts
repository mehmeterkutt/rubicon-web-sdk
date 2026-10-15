// Sessions (step 6.2): the port of the Android `internal/session` package over the session cookie
// shared by tabs and subdomains (Web Session 1 to 5).
export {
  decodeSessionCookie,
  encodeSessionCookie,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_VERSION,
  sessionCookieName,
} from './session-cookie';
export type { SessionState } from './session-cookie';
export { CLOCK_TOLERANCE_MS, HEARTBEAT_MS, MAX_SESSION_DURATION_MS, SessionManager } from './session-manager';
export type { SessionCall, SessionEvent, SessionManagerOptions, SessionOutcome } from './session-manager';
