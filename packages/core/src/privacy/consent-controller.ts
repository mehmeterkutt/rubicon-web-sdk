import type { Consent } from '../config/types';
import type { Log } from '../log';
import type { Clock, CookieJar } from '../platform';
import { cookieValues } from '../storage/cookie-text';
import type { ConsentDecision, ConsentRecord, ConsentStore } from '../storage/consent-store';
import type { StoreAccess } from '../storage/store-record';
import {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  consentCookieName,
  decodeConsentCookie,
  encodeConsentCookie,
} from './consent-cookie';

/**
 * Where collection stands (Privacy 1, 4, Web Privacy 1, Web Logging 4): `granted` collects and sends;
 * `pending` collects into this page's memory and writes nothing; `denied` (opted out) creates
 * nothing new, writes only the decision and starts no upload.
 */
export type ConsentState = Consent | ConsentDecision;

/** What a {@link ConsentController} is made of. */
export interface ConsentControllerOptions {
  /** The first 16 hex characters of the SHA-256 of the API key (Web Identity 4). */
  readonly keyHash: string;
  readonly cookies: CookieJar;
  /** `.consent`, the cookie's mirror (Web Privacy 2). */
  readonly store: Pick<ConsentStore, 'read' | 'save'>;
  /** The stores' access level: in the memory-only mode the decision is per page (Web Privacy 2, point 5). */
  readonly accessLevel: () => StoreAccess['level'];
  readonly log: Log;
  readonly clock: Clock;
  /** `privacy.defaultConsent`: the state while no decision is known (Privacy 4). */
  readonly defaultConsent: Consent;
  /** `privacy.persistConsent`: whether the decision is stored and read (Privacy 2). */
  readonly persistConsent: boolean;
  /** `Secure` on the cookie: an `https` page (Web Identity 1). */
  readonly secure: boolean;
  /** The identity cookie's `Domain`, `undefined` for host-only (Web Privacy 2, point 1; step 7.2). */
  readonly cookieDomain: () => string | undefined;
  /**
   * Called when a fresh read finds another state than the one last applied, whether this page or
   * another tab made the decision; the new state is applied before the call (step 6.5).
   */
  readonly onChange: (from: ConsentState, to: ConsentState) => void;
}

const COOKIE_LABEL = 'consent cookie';

/**
 * The user's consent decision (Privacy 1, 2, 4, Web Privacy 1, 2), the port of the Android
 * `ConsentController` with storage, not memory, as the source of truth:
 *
 * - The decision lives in the cookie `rubicon_<keyHash>_c`, the authority, and its mirror `.consent`;
 *   on a disagreement the later `decided_at` wins, and the mirror answers when the cookie is missing
 *   or unreadable (Web Privacy 2, point 1). This page's own decision takes part with its time, so a
 *   decision whose writes did not stick still holds for the page.
 * - {@link state} reads both fresh, on every public call and before every upload (Web Privacy 2,
 *   point 2): an opt-out in one tab stops another at its next call.
 * - With `persistConsent: false`, and in the memory-only mode, neither is read or written: the
 *   decision is this page's, else `defaultConsent` (Web Privacy 2, points 4 and 5).
 * - A decision writes only `{ state, decided_at }`, never an identifier (Web Logging 4 point 1).
 *
 * The consequences of a change are the caller's, through `onChange`. Nothing here throws.
 */
export class ConsentController {
  private readonly cookieName: string;
  // This page's own latest decision, kept whether or not it could be stored.
  private decision: ConsentRecord | undefined;
  // The state whose consequences were applied last; `undefined` before the first read.
  private appliedState: ConsentState | undefined;

  constructor(private readonly options: ConsentControllerOptions) {
    this.cookieName = consentCookieName(options.keyHash);
  }

  /**
   * The state now, from fresh reads. A state other than the one last applied is applied first:
   * `onChange` runs before this returns. The first read applies nothing; the caller sets up the page
   * for it (step 6.5).
   */
  state(): ConsentState {
    const now = this.read();
    const before = this.appliedState;
    this.appliedState = now;
    if (before !== undefined && before !== now) this.options.onChange(before, now);
    return now;
  }

  /** The state last applied, without reading again; `undefined` before the first {@link state}. */
  get applied(): ConsentState | undefined {
    return this.appliedState;
  }

  /** `optIn()`: the decision `granted`, stored when `persistConsent` is on, then applied (Privacy 2). */
  optIn(): void {
    this.decide('granted');
  }

  /** `optOut()`: the decision `denied`, stored when `persistConsent` is on, then applied (Privacy 1, 2). */
  optOut(): void {
    this.decide('denied');
  }

  private decide(state: ConsentDecision): void {
    const record: ConsentRecord = { state, decidedAt: this.options.clock.now() };
    this.decision = record;
    if (this.stores()) {
      this.writeCookie(record);
      this.options.store.save(record);
    }
    this.state();
  }

  private read(): ConsentState {
    let latest = this.decision;
    if (this.stores()) {
      // The cookie first, so it wins a tie as the authority (Web Privacy 2, point 1).
      for (const stored of [this.readMirror(), this.readCookie()]) {
        if (stored !== undefined && (latest === undefined || stored.decidedAt >= latest.decidedAt)) latest = stored;
      }
    }
    return latest?.state ?? this.options.defaultConsent;
  }

  private stores(): boolean {
    return this.options.persistConsent && this.options.accessLevel() !== 'none';
  }

  private readMirror(): ConsentRecord | undefined {
    const read = this.options.store.read();
    return read.status === 'present' ? read.state : undefined;
  }

  // The first value of the name wins, as for the identity cookie (RFC 6265 section 5.4).
  private readCookie(): ConsentRecord | undefined {
    let text: string;
    try {
      text = this.options.cookies.readAll();
    } catch (error) {
      this.reportUnreadable('The consent cookie cannot be read', error);
      return undefined;
    }
    const first = cookieValues(text, this.cookieName)[0];
    if (first === undefined) return undefined;
    const record = decodeConsentCookie(first);
    if (record === undefined) this.reportUnreadable('The consent cookie exists but cannot be read', undefined);
    return record;
  }

  /** Writes the decision and reads it back; a write that did not stick leaves the decision in memory. */
  private writeCookie(record: ConsentRecord): void {
    const text = encodeConsentCookie(record);
    let error: unknown;
    let values: string[] = [];
    try {
      this.options.cookies.write({
        name: this.cookieName,
        value: text,
        domain: this.options.cookieDomain(),
        path: '/',
        maxAgeSeconds: CONSENT_COOKIE_MAX_AGE_SECONDS,
        sameSite: 'Lax',
        secure: this.options.secure,
      });
      values = cookieValues(this.options.cookies.readAll(), this.cookieName);
    } catch (caught) {
      error = caught;
    }
    if (values.indexOf(text) >= 0) return;
    // Logged once per page and counted every time (Logging 3).
    this.options.log.error(
      'STORAGE_WRITE_FAILED',
      () => 'Could not write the consent cookie; the decision holds for this page and the mirror',
      { error, repeatKey: COOKIE_LABEL },
    );
  }

  private reportUnreadable(what: string, error: unknown): void {
    this.options.log.warn(
      'STORE_UNREADABLE',
      () => `${what}; the consent mirror is used until a new decision replaces it`,
      {
        error,
        repeatKey: COOKIE_LABEL,
      },
    );
  }
}
