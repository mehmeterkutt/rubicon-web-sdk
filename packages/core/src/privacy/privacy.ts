import type { Consent } from '../config/types';
import type { Identity } from '../identity/identity';
import type { Log } from '../log';
import type { Clock, CookieJar, LifecycleSource, StorageSignal, Unsubscribe } from '../platform';
import type { Writer } from '../pipeline/writer';
import type { RemoteConfigClient } from '../remote/remote-config-client';
import type { SessionManager } from '../session/session-manager';
import type { ChunkStore } from '../storage/chunk-store';
import type { StoreAccess } from '../storage/store-record';
import type { Stores } from '../storage/stores';
import { ConsentController } from './consent-controller';
import type { ConsentState } from './consent-controller';

/** What {@link Privacy} is made of; the factory (step 6.7) wires it. */
export interface PrivacyOptions {
  /** The first 16 hex characters of the SHA-256 of the API key (Web Identity 4). */
  readonly keyHash: string;
  readonly cookies: CookieJar;
  /** The five stores; their access level is set here (step 4.1). */
  readonly stores: Stores;
  readonly log: Log;
  readonly clock: Clock;
  readonly defaultConsent: Consent;
  readonly persistConsent: boolean;
  /** `Secure` on the cookie: an `https` page (Web Identity 1). */
  readonly secure: boolean;
  /** The identity cookie's `Domain`, `undefined` for host-only (Web Privacy 2; step 7.2). */
  readonly cookieDomain: () => string | undefined;
  readonly identity: Pick<Identity, 'deviceId' | 'clearLocalData'>;
  readonly sessions: Pick<SessionManager, 'endSilently' | 'clear'>;
  readonly chunks: Pick<ChunkStore, 'discardHeld' | 'expireStored' | 'clear' | 'replaceHeldDeviceId'>;
  readonly writer: Pick<Writer, 'flush' | 'replaceDeviceId'>;
  readonly remote: Pick<RemoteConfigClient, 'fetchIfDue'>;
  readonly lifecycle: LifecycleSource;
  /** The `storage` event, by which a pending tab learns of another tab's decision (Web Privacy 2). */
  readonly storageEvents: StorageSignal;
}

/**
 * Privacy controls on the web (Privacy 1 to 4, Web Privacy 1 to 3, Web Logging 4): the consent
 * decision of {@link ConsentController} and what each state means for the page.
 *
 * - Granted: the stores, cookies and queue are used (`StoreAccess` `full`).
 * - Pending: nothing is written to the browser and only the consent record is read; identity,
 *   session and events live in this page's memory (`consent`, Web Privacy 1). `optIn()` resolves the
 *   identity (a stored one wins, the page's person changes are replayed onto it and its id written
 *   into the waiting events), writes and sends; `optOut()` drops the waiting events uncounted.
 * - Refused: only the decision is written; no event of any kind, the open session ends without an
 *   event, events accepted and not yet written are discarded, no new upload starts, requests in
 *   flight complete and settle their chunks, the stored queue waits for `optIn()` or the 3-day rule,
 *   counters, retry state and `.pause` stay in memory, and no remote configuration request is made
 *   (Privacy 1, Web Logging 4). The identity cookie is read, never written. `optIn()` resumes
 *   without an event, flushes, and forgets the counts made while refused (Web Logging 5).
 * - A pending tab reads the decision again on the `storage` event, on becoming visible and at its
 *   next call (Web Privacy 2, point 3); every state is read fresh at every call and upload.
 *
 * In the memory-only mode (Web Disk 4) the access level stays `none` and the decision is per page.
 */
export class Privacy {
  private readonly consent: ConsentController;
  private unsubscribes: Unsubscribe[] = [];
  private started = false;

  constructor(private readonly options: PrivacyOptions) {
    this.consent = new ConsentController({
      keyHash: options.keyHash,
      cookies: options.cookies,
      store: options.stores.consent,
      accessLevel: () => options.stores.accessLevel,
      log: options.log,
      clock: options.clock,
      defaultConsent: options.defaultConsent,
      persistConsent: options.persistConsent,
      secure: options.secure,
      cookieDomain: options.cookieDomain,
      onChange: (from, to) => {
        this.onChange(from, to);
      },
    });
  }

  /**
   * The first read, before anything else of the instance reads storage: the stores' access level
   * from the decision, the 3-day rule for a refused page's stored queue (Web Logging 4 point 3), and
   * the listeners of Web Privacy 2 point 3. Returns the state.
   */
  start(): ConsentState {
    const state = this.consent.state();
    if (this.started) return state;
    this.started = true;
    this.setAccess(state === 'granted' ? 'full' : 'consent');
    if (state === 'denied') this.options.chunks.expireStored();
    const mirrorKey = this.options.stores.consent.key;
    this.unsubscribes = [
      this.options.storageEvents.subscribe((key) => {
        if (key === null || key === mirrorKey) this.refresh();
      }),
      this.options.lifecycle.subscribe((event) => {
        if (event === 'visible' || event === 'pageshow-persisted') this.refresh();
      }),
    ];
    return state;
  }

  /** Stops listening; for tests and the factory's shutdown. */
  stop(): void {
    this.unsubscribes.forEach((unsubscribe) => {
      unsubscribe();
    });
    this.unsubscribes = [];
  }

  /** The state now, read fresh; a change found is applied first (Web Privacy 2, point 2). */
  state(): ConsentState {
    return this.consent.state();
  }

  /** `isOptedOut`: nothing is being sent now, pending or refused (Privacy 4). */
  isOptedOut(): boolean {
    return this.state() !== 'granted';
  }

  /** Whether new events are created and written: not while refused (Privacy 1, Web Logging 4). */
  eventsAllowed(): boolean {
    return this.state() !== 'denied';
  }

  /**
   * Whether a new upload may start: only while granted (Web Logging 4 point 3, Privacy 4). A refused
   * page applies the 3-day rule to the stored queue here, where a granted page would walk it before
   * the upload (section 15, step 4.2).
   */
  uploadsAllowed(): boolean {
    const state = this.state();
    if (state === 'denied') this.options.chunks.expireStored();
    return state === 'granted';
  }

  /**
   * Whether consent is refused as last applied, without reading again: the identity asks it inside
   * its own reads (`IdentityOptions.refused`), which must not start a change of state.
   */
  refused(): boolean {
    return this.consent.applied === 'denied';
  }

  optIn(): void {
    this.consent.optIn();
  }

  optOut(): void {
    this.consent.optOut();
  }

  /**
   * `clearLocalData()` (Privacy 3, Web Privacy 3): a new identity, every chunk and marker of the key
   * and the session deleted, no event and no count. Granted: the new identity is written, `.device`
   * renewed without counters and retry state, `.remote` and `.pause` kept. Pending or refused: what
   * is stored is deleted and nothing written, the new id waiting in memory for `optIn()`; `.pause`
   * goes too while refused (Web Logging 4 point 6; plan section 15, step 6.5, the user's answers).
   * The consent records are kept.
   */
  clearLocalData(): void {
    const state = this.state();
    const { stores } = this.options;
    this.options.identity.clearLocalData();
    this.options.sessions.clear();
    this.options.chunks.clear();
    if (state === 'denied' && stores.accessLevel === 'consent') stores.pause.erase();
    this.options.log.debug(() => 'Local data cleared');
  }

  private refresh(): void {
    try {
      this.consent.state();
    } catch {
      // Never into the page from a listener; the next call reads the decision again.
      this.options.log.debug(() => 'Reading the consent decision failed; the next call reads it again');
    }
  }

  private onChange(from: ConsentState, to: ConsentState): void {
    switch (to) {
      case 'denied':
        this.toRefused(from);
        return;
      case 'granted':
        this.toGranted(from);
        return;
      case 'pending':
        // A stored decision has gone (site data cleared): nothing more is written (Web Privacy 1).
        this.setAccess('consent');
        return;
    }
  }

  private toRefused(from: ConsentState): void {
    const { options } = this;
    // The open session ends without an event (Privacy 1); its cookie goes while it still may.
    options.sessions.endSilently();
    // What was collected with consent is written before only the decision may be (Web Logging 4).
    if (from === 'granted') options.stores.persist();
    this.setAccess('consent');
    // Events waiting while pending were collected without consent: dropped uncounted (Privacy 4).
    if (from === 'pending') options.chunks.discardHeld();
    options.log.info(() => 'The user opted out; nothing new is collected or sent');
  }

  private toGranted(from: ConsentState): void {
    const { options } = this;
    const before = options.identity.deviceId;
    // Counts made while refused are never stored (Web Logging 5 point 5); a pending page's merge.
    if (from === 'denied') options.stores.device.discardCounts();
    this.setAccess('full');
    // The stored identity wins and the page's held person changes are replayed onto it (identity).
    const after = options.identity.deviceId;
    if (from === 'pending') {
      // "Applied to the waiting events" (Web Privacy 1): their device id, not their user id.
      options.writer.replaceDeviceId(before, after);
      options.chunks.replaceHeldDeviceId(before, after);
    }
    options.log.info(() => 'The user opted in; collection resumes');
    // `optIn()` writes and sends what waited (Web Privacy 1, Privacy 4 as changed on 2026-10-14) and
    // makes the remote configuration request a pending or refused page did not (Web Logging 4 point 5).
    options.writer.flush();
    options.remote.fetchIfDue('granted');
  }

  private setAccess(level: Exclude<StoreAccess['level'], 'none'>): void {
    // The memory-only mode is the platform's decision and stays (Web Disk 4, Web Privacy 2 point 5).
    if (this.options.stores.accessLevel !== 'none') this.options.stores.accessLevel = level;
  }
}
