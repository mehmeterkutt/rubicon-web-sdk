import type { JsonValue } from '../json';
import type { Log } from '../log';
import type { CookieJar, RandomSource } from '../platform';
import { cookieValues } from '../storage/cookie-text';
import { NO_DIAGNOSTICS, NO_RETRY } from '../storage/device-store';
import { ANONYMOUS } from '../storage/person-store';
import type { PersonState } from '../storage/person-store';
import type { StoreChange } from '../storage/store-record';
import type { Stores } from '../storage/stores';
import { newPersonEpoch } from '../util/random-hex';
import type { UuidV7Generator } from '../util/uuid-v7-generator';
import { normalizeProperties, replaceLoneSurrogates } from '../validation/property-normalizer';
import { reportPropertyProblems } from '../validation/property-problem';
import type { PropertyValue } from '../validation/property-value';
import {
  decodeIdentityCookie,
  encodeIdentityCookie,
  IDENTITY_COOKIE_MAX_AGE_SECONDS,
  identityCookieName,
  isDeviceId,
  isValidUserId,
  MAX_USER_ID_LENGTH,
  sameIdentity,
} from './identity-cookie';
import type { IdentityCookieValue } from './identity-cookie';

/** Who an event belongs to, read from storage when the event is tracked (Web Identity 3). */
export interface IdentitySnapshot {
  readonly deviceId: string;
  /** `null` while anonymous. */
  readonly userId: string | null;
  /** The epoch the session cookie must carry to belong to this person (Web Session 5). */
  readonly personEpoch: string;
  /** A copy of the super properties, merged into `track` and `screen` events (Event Model 1). */
  readonly superProperties: Readonly<Record<string, PropertyValue>>;
}

/** Whether an `identify` call produces an `IdentifyEvent` (Identity 3). */
export type IdentifyDecision =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'send';
      /** Normalized; sent with this event only and never stored (Identity 3). */
      readonly traits: Record<string, PropertyValue>;
      /** The normalizer stopped above the size limit; the writer drops the event (step 2.5 row). */
      readonly traitsOversize: boolean;
      readonly identity: IdentitySnapshot;
    };

/** How one store reads for the matrix of Web Identity 1. */
export type IdentityCell = 'id' | 'missing' | 'unreadable';

/** Where a call's identity comes from. */
export type IdentitySource = 'cookie' | 'mirror' | 'new' | 'temporary';

/** One row of the matrix: which store's id is used, and which store is written. */
export interface IdentityOutcome {
  readonly use: IdentitySource;
  readonly writeCookie: boolean;
  readonly writeMirror: boolean;
}

/** A row of the matrix: the cookie, then the `.device` mirror, `same` or `different` when both hold an id. */
export type IdentityMatrixRow =
  | 'id/same'
  | 'id/different'
  | 'id/missing'
  | 'id/unreadable'
  | 'missing/id'
  | 'missing/missing'
  | 'missing/unreadable'
  | 'unreadable/id'
  | 'unreadable/missing'
  | 'unreadable/unreadable';

/**
 * The read matrix of Web Identity 1, row by row: a new id is never generated while either store
 * holds a valid one, the cookie wins a disagreement, an unreadable store is never written, and only
 * when nothing can be read does the page use a temporary id (with the `STORE_UNREADABLE` WARN of the
 * unreadable store).
 */
export const IDENTITY_MATRIX: Readonly<Record<IdentityMatrixRow, IdentityOutcome>> = {
  'id/same': { use: 'cookie', writeCookie: false, writeMirror: false },
  'id/different': { use: 'cookie', writeCookie: false, writeMirror: true },
  'id/missing': { use: 'cookie', writeCookie: false, writeMirror: true },
  'id/unreadable': { use: 'cookie', writeCookie: false, writeMirror: false },
  'missing/id': { use: 'mirror', writeCookie: true, writeMirror: false },
  'missing/missing': { use: 'new', writeCookie: true, writeMirror: true },
  'missing/unreadable': { use: 'temporary', writeCookie: false, writeMirror: false },
  'unreadable/id': { use: 'mirror', writeCookie: false, writeMirror: false },
  'unreadable/missing': { use: 'temporary', writeCookie: false, writeMirror: false },
  'unreadable/unreadable': { use: 'temporary', writeCookie: false, writeMirror: false },
};

/** What {@link Identity} is made of. */
export interface IdentityOptions {
  /** The first 16 hex characters of the SHA-256 of the API key (Web Identity 4). */
  readonly keyHash: string;
  readonly cookies: CookieJar;
  /** The instance's stores; their access level also decides whether the cookie is used (Web Privacy 1). */
  readonly stores: Stores;
  readonly log: Log;
  /** The instance's generator: device ids are UUIDv7 like every other id (Web Event Model 3). */
  readonly ids: Pick<UuidV7Generator, 'next'>;
  readonly random: RandomSource;
  /** `Secure` on the cookie: an `https` page (Web Identity 1). */
  readonly secure: boolean;
  /**
   * The cookie's `Domain`, `undefined` for a host-only cookie: the decision of Web Identity 2, which
   * the platform supplies (step 7.2). Asked at every cookie write.
   */
  readonly cookieDomain: () => string | undefined;
  /** `false` while consent is refused: `identify` then changes the person without an event (Privacy 1). */
  readonly eventsAllowed: () => boolean;
  /** Asks the writer to persist the stores' pending changes in its next slice (Web Disk 3). */
  readonly requestPersist: () => void;
  /**
   * Called with the identity before `reset()` or a change of user clears the person, so the session
   * can end with the previous person's identity first (Web Session 5, Android log 6.1).
   */
  readonly onPersonCleared?: (previous: IdentitySnapshot) => void;
}

type CookieRead =
  | { readonly status: 'present'; readonly value: IdentityCookieValue }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' };

type MirrorRead =
  | { readonly status: 'present'; readonly deviceId: string }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' };

/** The identity a call works on, with whether `identify`, `reset()` may write the cookie. */
interface Resolved extends IdentityCookieValue {
  readonly cookieWritable: boolean;
}

/** This page's own copy: the last identity it resolved or set, or its temporary one. */
interface PageIdentity {
  deviceId: string | undefined;
  userId: string | null;
  personEpoch: string | undefined;
  /** Whether a store held this identity; `false` for a temporary one that was never stored. */
  stored: boolean;
}

const NO_EVENT: IdentifyDecision = { kind: 'none' };
const MISSING = { status: 'missing' } as const;
const UNREADABLE = { status: 'unreadable' } as const;
// Repeat keys for the log lines about the cookie, apart from those about the stores.
const COOKIE_LABEL = 'identity cookie';
const DEVICE_LABEL = 'device';

/**
 * The identity of the instance (Identity 1 to 5, Web Identity 1 to 4, Web Session 5): the identity
 * cookie `rubicon_<keyHash>` is the authority for `device_id`, `user_id` and `person_epoch`; the
 * `.device` record mirrors the device id and `.person` the user id with the super properties. The
 * port of the Android `Identity`, with storage as the source of truth instead of memory:
 *
 * - Every call reads the cookie and the records again and takes its identity from them (Web Identity
 *   3); this page's memory is only the fallback the matrix names, never a cache another tab cannot
 *   change. Parsing is skipped while the cookie text is unchanged.
 * - The cookie is written only on the first visit (the matrix rows that write it), `identify`,
 *   `reset()` and `clearLocalData()` (Web Session 5); a session heartbeat never touches it. Every
 *   write is read back: another page's value is adopted, a missing one means the write did not stick
 *   and this page keeps the identity it had.
 * - The first-visit race is narrowed by reading again right before generating and reading back
 *   after writing (Web Identity 3).
 * - While the stores may not be used (consent pending or refused, the memory-only mode), the
 *   identity lives in this page's memory: a temporary device id made at first need, and the person's
 *   changes held by the stores (Web Privacy 1, Web Logging 4, Web Disk 4). When access becomes full,
 *   a stored identity wins and the temporary one is written only where both stores are empty.
 *
 * Nothing here throws; a cookie or storage failure is logged and degrades to memory.
 */
export class Identity {
  private readonly cookieName: string;
  private readonly page: PageIdentity = { deviceId: undefined, userId: null, personEpoch: undefined, stored: false };
  // The cookie text last parsed and what it gave (Web Identity 3: a cost measure only).
  private parsedText: string | undefined;
  private parsed: CookieRead = MISSING;
  // A value this page wrote that did not stick; it is not written again in this page.
  private refusedValue: string | undefined;

  constructor(private readonly options: IdentityOptions) {
    this.cookieName = identityCookieName(options.keyHash);
  }

  /** The device id of a call made now, for `Analytics.deviceId` (Identity 1). */
  get deviceId(): string {
    return this.resolve().deviceId;
  }

  /** The identity for an event tracked now (Web Identity 3, Public API 9). */
  snapshot(): IdentitySnapshot {
    return this.snapshotOf(this.resolve());
  }

  /**
   * The rules of Identity 3 and 4 over the identity read now. `undefined` when `userId` is invalid
   * and the call was ignored, with `INVALID_USER_ID` as a developer error (Web Public API 4).
   */
  identify(userId: unknown, traits: unknown): IdentifyDecision | undefined {
    if (!isValidUserId(userId)) {
      const reason = userIdProblem(userId);
      this.options.log.warn(
        'INVALID_USER_ID',
        () => `identify was called with a user id that is ${reason}; the call is ignored`,
        {
          developerError: true,
        },
      );
      return undefined;
    }
    const normalized = normalizeProperties(traits);
    reportPropertyProblems(normalized.problems, this.options.log);
    // None reaches the wire (Web Serialization 1); the length does not change.
    const user = replaceLoneSurrogates(userId);
    const current = this.resolve();
    let next: IdentityCookieValue | undefined;
    if (current.userId === null) {
      next = { deviceId: current.deviceId, userId: user, personEpoch: current.personEpoch };
      this.changePerson(current, next, (state) => ({ ...state, userId: user }));
    } else if (current.userId !== user) {
      this.clearPerson(current);
      // Never the ids themselves (Logging 4a).
      this.options.log.info(() => "A different user was identified; the previous person's state was reset");
      next = { deviceId: current.deviceId, userId: user, personEpoch: newPersonEpoch(this.options.random) };
      this.changePerson(current, next, () => ({ ...ANONYMOUS, userId: user, superProperties: new Map() }));
    }
    const send = next !== undefined || Object.keys(normalized.values).length > 0;
    if (!send || !this.options.eventsAllowed()) return NO_EVENT;
    return {
      kind: 'send',
      traits: normalized.values,
      traitsOversize: normalized.oversize,
      identity: this.snapshot(),
    };
  }

  /**
   * Back to anonymous (Identity 5): the person's user id and super properties are cleared and a new
   * `person_epoch` ends the open session for every tab (Web Session 5); the device id and the queue
   * stay. No event of its own.
   */
  reset(): void {
    const current = this.resolve();
    this.clearPerson(current);
    const next = { deviceId: current.deviceId, userId: null, personEpoch: newPersonEpoch(this.options.random) };
    this.changePerson(current, next, () => ({ ...ANONYMOUS, superProperties: new Map() }));
  }

  /**
   * The identity part of `clearLocalData()` (Web Privacy 3): a new device id and epoch without a
   * user id in the cookie (overwriting even an unreadable one, as an erasure), the `.device` mirror
   * renewed with its diagnostics counters and transient retry state deleted, `.person` deleted. No
   * event and no `Session Ended`; the queue and the session cookie are the caller's (step 6.5).
   * Without full access the new identity is made in memory only.
   */
  clearLocalData(): void {
    const next: IdentityCookieValue = {
      deviceId: this.options.ids.next(),
      userId: null,
      personEpoch: newPersonEpoch(this.options.random),
    };
    const { stores } = this.options;
    // Without access the new id waits in memory and is written when access comes (Web Logging 4).
    this.remember(next, stores.accessLevel === 'full');
    this.refusedValue = undefined;
    stores.person.remove();
    // TODO(step 6.5): while consent is refused the stored records and the identity cookie are
    // deleted too (Web Logging 4 point 6); the privacy step owns that erasure.
    if (stores.accessLevel !== 'full') return;
    this.writeCookie(next);
    stores.device.write((state) => ({
      ...state,
      deviceId: next.deviceId,
      retry: NO_RETRY,
      diagnostics: NO_DIAGNOSTICS,
    }));
  }

  /**
   * Adds a super property, validated now with the property rules (Web Public API 4); `null` is a
   * value, `undefined` an absent one (Web Serialization 2). Stored in `.person` of this origin only
   * (Web Identity 2), merged by its key and written in the writer's next slice (Web Disk 3). `false`
   * when the key or the value was dropped and nothing changed.
   */
  register(key: unknown, value: unknown): boolean {
    const normalized = normalizeProperties(new Map([[key, value]]));
    reportPropertyProblems(normalized.problems, this.options.log);
    const keys = Object.keys(normalized.values);
    const stored = keys[0];
    if (stored === undefined) return false;
    const current = this.resolve();
    this.options.stores.person.register(stored, normalized.values[stored] ?? null);
    this.stampPerson(current);
    this.options.requestPersist();
    return true;
  }

  /** Removes a super property; a key that is not a string names none. */
  unregister(key: unknown): void {
    if (typeof key !== 'string') return;
    const current = this.resolve();
    this.options.stores.person.unregister(replaceLoneSurrogates(key));
    this.stampPerson(current);
    this.options.requestPersist();
  }

  private snapshotOf(identity: IdentityCookieValue): IdentitySnapshot {
    const superProperties: Record<string, PropertyValue> = {};
    this.options.stores.person.state.superProperties.forEach((value, key) => {
      define(superProperties, key, toPropertyValue(value));
    });
    return {
      deviceId: identity.deviceId,
      userId: identity.userId,
      personEpoch: identity.personEpoch,
      superProperties,
    };
  }

  /** The identity of a call made now: the matrix over fresh reads, or this page's memory. */
  private resolve(): Resolved {
    if (this.options.stores.accessLevel !== 'full') return this.temporary();
    return this.fromStores(this.readCookie(), this.readMirror(), true);
  }

  private fromStores(cookie: CookieRead, mirror: MirrorRead, firstPass: boolean): Resolved {
    const outcome = IDENTITY_MATRIX[matrixRow(cookie, mirror)];
    if (cookie.status === 'present' && outcome.use === 'cookie') {
      if (outcome.writeMirror) this.writeMirror(cookie.value.deviceId);
      return this.adopt(cookie.value, true);
    }
    if (mirror.status === 'present' && outcome.use === 'mirror') {
      const value = this.fromMirror(mirror.deviceId);
      if (!outcome.writeCookie) return this.adopt(value, false);
      return this.adopt(this.writeCookie(value) ?? value, true);
    }
    if (outcome.use === 'new') {
      // Read again right before generating: another page may have written meanwhile (Web Identity 3).
      if (firstPass) return this.fromStores(this.readCookie(), this.readMirror(), false);
      return this.firstVisit();
    }
    return this.temporary();
  }

  // Both stores were seen empty twice: a new id written to both. A temporary identity of this page,
  // made while consent was pending or while nothing could be written, becomes the stored one (Web
  // Privacy 1); one that was stored and has since gone, such as after the user cleared the site's
  // data, is not brought back.
  private firstVisit(): Resolved {
    const page = this.page;
    const temporary = !page.stored && page.deviceId !== undefined && page.personEpoch !== undefined;
    const value: IdentityCookieValue = temporary
      ? { deviceId: page.deviceId as string, userId: page.userId, personEpoch: page.personEpoch as string }
      : { deviceId: this.options.ids.next(), userId: null, personEpoch: newPersonEpoch(this.options.random) };
    const mirrored = this.writeMirror(value.deviceId);
    const written = this.writeCookie(value);
    if (written !== undefined && written.deviceId !== value.deviceId) this.writeMirror(written.deviceId);
    const result = this.adopt(written ?? value, true);
    // Neither write stuck: the identity is this page load's only, and stays its own (Web Identity 1).
    if (written === undefined && !mirrored) this.page.stored = false;
    return result;
  }

  // The cookie is missing or unreadable and `.device` holds an id: the user id and epoch of the
  // `.person` that belongs to that id, else those this page knows for it, else anonymous and a new
  // epoch.
  private fromMirror(deviceId: string): IdentityCookieValue {
    const page = this.page;
    const known = page.deviceId === deviceId;
    const person = this.options.stores.person.read();
    let userId = known ? page.userId : null;
    let personEpoch = known ? page.personEpoch : undefined;
    if (person.status === 'present' && person.state.deviceId === deviceId) {
      userId = isValidUserId(person.state.userId) ? person.state.userId : null;
      personEpoch = person.state.personEpoch ?? personEpoch;
    }
    return { deviceId, userId, personEpoch: personEpoch ?? newPersonEpoch(this.options.random) };
  }

  // Nothing can be read, or the stores may not be used: this page's id, made at first need.
  private temporary(): Resolved {
    const page = this.page;
    const deviceId = page.deviceId ?? this.options.ids.next();
    const personEpoch = page.personEpoch ?? newPersonEpoch(this.options.random);
    page.deviceId = deviceId;
    page.personEpoch = personEpoch;
    return { deviceId, userId: page.userId, personEpoch, cookieWritable: false };
  }

  private adopt(value: IdentityCookieValue, cookieWritable: boolean): Resolved {
    this.remember(value);
    this.dropStalePerson(value);
    // Changes held while the stores could not be used belong to the identity that holds now (step 6.5
    // applies a stored identity to the waiting events).
    if (this.options.stores.person.hasPendingChanges) this.stampPerson(value);
    return { ...value, cookieWritable };
  }

  private remember(value: IdentityCookieValue, stored = true): void {
    this.page.deviceId = value.deviceId;
    this.page.userId = value.userId;
    this.page.personEpoch = value.personEpoch;
    this.page.stored = stored;
  }

  // A `.person` of another device id or epoch is stale: after `clearLocalData()` on another
  // subdomain (Web Privacy 3), or after a change of person there, whose new epoch this origin's record
  // does not carry (section 15, step 6.1, the user's answer). It is deleted, so its user id and super
  // properties never move to the new identity. A record without one of the two, from an older
  // writer, is not stale; the next write stamps it.
  private dropStalePerson(value: IdentityCookieValue): void {
    const person = this.options.stores.person.read();
    if (person.status !== 'present') return;
    const { deviceId, personEpoch } = person.state;
    const otherDevice = deviceId !== undefined && deviceId !== value.deviceId;
    const otherPerson = personEpoch !== undefined && personEpoch !== value.personEpoch;
    if (otherDevice || otherPerson) this.options.stores.person.remove();
  }

  // The person changes now, in this page at once and in storage with one write each, so that another
  // tab's next call never pairs the new cookie with the previous person's record (Web Identity 3).
  private changePerson(current: Resolved, next: IdentityCookieValue, change: StoreChange<PersonState>): void {
    this.remember(next, this.page.stored);
    const { stores } = this.options;
    if (stores.accessLevel !== 'full') {
      // Stamped when access comes, with the identity that holds then (see `adopt`).
      stores.person.update(change);
      return;
    }
    const stamped: StoreChange<PersonState> = (state) => ({
      ...change(state),
      deviceId: next.deviceId,
      personEpoch: next.personEpoch,
    });
    if (current.cookieWritable) {
      const stored = this.writeCookie(next);
      // Another page wrote at the same moment and wrote last: its identity holds (Web Session 5).
      if (stored !== undefined && !sameIdentity(stored, next)) this.remember(stored, true);
    }
    stores.person.write(stamped);
  }

  private clearPerson(current: Resolved): void {
    this.options.onPersonCleared?.(this.snapshotOf(current));
  }

  // `.person` records the identity it belongs to (Web Privacy 3); held changes are stamped later.
  private stampPerson(identity: IdentityCookieValue): void {
    if (this.options.stores.accessLevel !== 'full') return;
    const { deviceId, personEpoch } = identity;
    this.options.stores.person.update((state) =>
      state.deviceId === deviceId && state.personEpoch === personEpoch ? state : { ...state, deviceId, personEpoch },
    );
  }

  // Whether `.device` holds `deviceId` afterwards.
  private writeMirror(deviceId: string): boolean {
    const result = this.options.stores.device.write((state) =>
      state.deviceId === deviceId ? state : { ...state, deviceId },
    );
    return result === 'written' || result === 'unchanged';
  }

  /**
   * Writes the identity cookie and reads it back (Web Identity 1, 3). Returns what the cookie holds
   * afterwards: `value` when the write stuck, another page's identity when one was written meanwhile,
   * `undefined` when it did not stick (cookies blocked, refused by the browser, or the access threw),
   * logged once per page; the page then keeps `value` in memory.
   */
  private writeCookie(value: IdentityCookieValue): IdentityCookieValue | undefined {
    const text = encodeIdentityCookie(value);
    if (text === this.refusedValue) return undefined;
    let error: unknown;
    let values: string[] = [];
    try {
      this.options.cookies.write({
        name: this.cookieName,
        value: text,
        domain: this.options.cookieDomain(),
        path: '/',
        maxAgeSeconds: IDENTITY_COOKIE_MAX_AGE_SECONDS,
        sameSite: 'Lax',
        secure: this.options.secure,
      });
      values = cookieValues(this.options.cookies.readAll(), this.cookieName);
    } catch (caught) {
      error = caught;
    }
    // Cookies of one name in two scopes are listed both; the write stuck if one of them is ours.
    if (values.indexOf(text) >= 0) return value;
    const other = values.map(decodeIdentityCookie).filter((read) => read !== undefined)[0];
    if (error === undefined && other !== undefined) return other;
    this.refusedValue = text;
    this.options.log.error(
      'STORAGE_WRITE_FAILED',
      () => 'Could not write the identity cookie; this page keeps the identity in memory',
      { error, repeatKey: COOKIE_LABEL },
    );
    return undefined;
  }

  private readCookie(): CookieRead {
    let text: string;
    try {
      text = this.options.cookies.readAll();
    } catch (error) {
      this.reportUnreadable(COOKIE_LABEL, 'The identity cookie cannot be read', error);
      return UNREADABLE;
    }
    if (text === this.parsedText) return this.parsed;
    // The first of several values wins; the order is the browser's (RFC 6265 section 5.4).
    const first = cookieValues(text, this.cookieName)[0];
    const value = first === undefined ? undefined : decodeIdentityCookie(first);
    let read: CookieRead = MISSING;
    if (value !== undefined) read = { status: 'present', value };
    else if (first !== undefined) read = UNREADABLE;
    if (read.status === 'unreadable') {
      this.reportUnreadable(COOKIE_LABEL, 'The identity cookie exists but cannot be read', undefined);
    }
    this.parsedText = text;
    this.parsed = read;
    return read;
  }

  private readMirror(): MirrorRead {
    const read = this.options.stores.device.read();
    if (read.status !== 'present') return read.status === 'missing' ? MISSING : UNREADABLE;
    const deviceId = read.state.deviceId;
    if (deviceId === undefined) return MISSING;
    if (isDeviceId(deviceId)) return { status: 'present', deviceId };
    this.reportUnreadable(DEVICE_LABEL, 'The device store holds a device id that is not a UUID', undefined);
    return UNREADABLE;
  }

  private reportUnreadable(label: string, what: string, error: unknown): void {
    this.options.log.warn(
      'STORE_UNREADABLE',
      () => `${what}; this page keeps its identity in memory and leaves the stored value untouched`,
      { error, repeatKey: label },
    );
  }
}

function matrixRow(cookie: CookieRead, mirror: MirrorRead): IdentityMatrixRow {
  if (cookie.status === 'present' && mirror.status === 'present') {
    return cookie.value.deviceId === mirror.deviceId ? 'id/same' : 'id/different';
  }
  const cookieCell: IdentityCell = cookie.status === 'present' ? 'id' : cookie.status;
  const mirrorCell: IdentityCell = mirror.status === 'present' ? 'id' : mirror.status;
  // Both `id` was handled above, so the pair is one of the other rows.
  return `${cookieCell}/${mirrorCell}` as IdentityMatrixRow;
}

function userIdProblem(userId: unknown): string {
  if (typeof userId !== 'string') return 'not a string';
  return userId.length > MAX_USER_ID_LENGTH ? `longer than ${String(MAX_USER_ID_LENGTH)} characters` : 'blank';
}

// A stored super property as a property value: the same tree, a new copy.
function toPropertyValue(value: JsonValue): PropertyValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return (value as readonly JsonValue[]).map(toPropertyValue);
  const copy: Record<string, PropertyValue> = {};
  const object = value as { readonly [key: string]: JsonValue | undefined };
  for (const key of Object.keys(object)) {
    const item = object[key];
    if (item !== undefined) define(copy, key, toPropertyValue(item));
  }
  return copy;
}

// Keys are defined rather than assigned, so a `__proto__` key stays a key.
function define(target: object, key: string, value: PropertyValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
