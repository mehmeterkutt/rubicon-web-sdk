import { MemoryStorageArea, RecordingSink, TestPlatform } from 'rubicon-analytics-testing';
import type { DelayedOutcome } from 'rubicon-analytics-testing';
import type { DropReason, EventUpdate, HttpOutcome, HttpRequest, IssueCode, PreparedEvent } from '../../src';
import {
  ChunkStore,
  EventPipeline,
  HttpClient,
  Identity,
  identityCookieName,
  keyHash,
  Log,
  parseQueueKey,
  Privacy,
  RemoteConfigClient,
  RetryPolicy,
  RuntimeFlags,
  SessionManager,
  Stores,
  storeKey,
  Uploader,
  UuidV7Generator,
  validateConfig,
  Writer,
} from '../../src';
import type { StoreName } from '../../src';

export const API_KEY = 'test-api-key';
export const KEY_HASH = keyHash(API_KEY);
export const IDENTITY_COOKIE = identityCookieName(KEY_HASH);
export const SESSION_COOKIE = `rubicon_${KEY_HASH}_s`;
export const CONSENT_COOKIE = `rubicon_${KEY_HASH}_c`;

/** What a page is configured with: `privacy` and anything else of `AnalyticsConfig`. */
export interface PrivacyPageOptions {
  readonly config?: Record<string, unknown>;
  /** Whether `start()` runs at once; `true` unless given. */
  readonly start?: boolean;
  /** The cookies' `Domain`, host-only unless given (Web Identity 2). */
  readonly domain?: string;
}

/** One wire event as stored or sent, the fields these tests look at. */
export interface WireEvent {
  readonly type: string;
  readonly event?: string;
  readonly message_id: string;
  readonly device_id: string;
  readonly user_id: string | null;
  readonly properties?: Record<string, unknown>;
  readonly context?: { readonly session?: { readonly id: string } };
}

/**
 * One page of the SDK wired as the core factory will wire it (step 6.7), over one page of a
 * `TestPlatform` browser: the log, the stores and their shared access level, the chunk store, the
 * identity, the session, the pipeline, the writer, the HTTP client, the retry policy, the uploader,
 * the remote configuration and the privacy controls. The public calls below are the factory's: the
 * consent decision read first, then the identity, the session and the event (Web Privacy 2, point 2).
 */
export class PrivacyPage {
  readonly sink = new RecordingSink();
  readonly updates: EventUpdate[] = [];
  readonly counted: IssueCode[] = [];
  readonly drops = new Map<DropReason, number>();
  readonly flags = new RuntimeFlags();
  readonly log: Log;
  readonly stores: Stores;
  readonly chunks: ChunkStore;
  readonly identity: Identity;
  readonly sessions: SessionManager;
  readonly pipeline: EventPipeline;
  readonly writer: Writer;
  readonly policy: RetryPolicy;
  readonly uploader: Uploader;
  readonly remote: RemoteConfigClient;
  readonly privacy: Privacy;
  private readonly ids: UuidV7Generator;

  constructor(
    readonly test: TestPlatform,
    options: PrivacyPageOptions = {},
  ) {
    const { snapshot } = validateConfig(
      { apiKey: API_KEY, flush: { at: 100, intervalMs: 60_000 }, ...options.config },
      { urls: test.platform.urls, pageScheme: test.pageScheme },
    );
    if (snapshot === undefined) throw new Error('invalid test configuration');
    const holder: { stores?: Stores } = {};
    this.log = new Log({
      level: 'debug',
      debug: false,
      sink: this.sink,
      eventObserver: (update) => {
        this.updates.push(update);
      },
      issues: {
        increment: (code) => {
          this.counted.push(code);
          holder.stores?.device.issueCounter.increment(code);
        },
      },
    });
    const { clock, scheduler } = test;
    this.stores = new Stores({ keyHash: KEY_HASH, storage: test.storage, log: this.log, clock });
    holder.stores = this.stores;
    const drops = {
      count: (reason: DropReason, events: number) => {
        this.drops.set(reason, (this.drops.get(reason) ?? 0) + events);
        this.stores.device.countDropped(reason, events);
      },
    };
    this.chunks = new ChunkStore({
      keyHash: KEY_HASH,
      storage: test.storage,
      access: this.stores.access,
      log: this.log,
      clock,
      random: test.random,
      drops,
    });
    this.ids = new UuidV7Generator(clock, test.random);
    const secure = test.pageScheme === 'https';
    const page = { privacy: undefined as Privacy | undefined };
    this.sessions = new SessionManager({
      keyHash: KEY_HASH,
      cookies: test.cookies,
      clock,
      ids: this.ids,
      log: this.log,
      inactivityTimeoutMs: snapshot.inactivityTimeoutMs,
      emitEvents: snapshot.autocapture.has('sessions'),
      secure,
      cookieDomain: () => options.domain,
      accessLevel: () => this.stores.accessLevel,
    });
    this.pipeline = new EventPipeline({
      config: snapshot,
      context: test.context,
      sessions: this.sessions,
      ids: this.ids,
      log: this.log,
    });
    this.identity = new Identity({
      keyHash: KEY_HASH,
      cookies: test.cookies,
      stores: this.stores,
      log: this.log,
      ids: this.ids,
      random: test.random,
      secure,
      cookieDomain: () => options.domain,
      eventsAllowed: () => page.privacy?.eventsAllowed() ?? true,
      refused: () => page.privacy?.refused() ?? false,
      requestPersist: () => {
        this.writer.requestPersist();
      },
      onPersonCleared: (previous) => {
        const ended = this.sessions.onPersonCleared(previous, test.lifecycle.isVisible());
        if (page.privacy?.eventsAllowed() === false) return;
        this.enqueue(this.pipeline.sessionEvents(ended, previous, this.pipeline.callTimeValues()));
      },
    });
    const http = new HttpClient({
      transport: test.transport,
      scheduler,
      clock,
      network: test.network,
      urls: test.platform.urls,
      log: this.log,
    });
    this.remote = new RemoteConfigClient({
      code: snapshot,
      store: this.stores.remote,
      http,
      flags: this.flags,
      clock,
      log: this.log,
    });
    this.writer = new Writer({
      pipeline: this.pipeline,
      chunks: this.chunks,
      startup: () => this.remote.startup(this.identity.deviceId).snapshot,
      flags: this.flags,
      eventsAllowed: () => page.privacy?.eventsAllowed() ?? true,
      currentDeviceId: () => this.identity.deviceId,
      drops,
      persist: () => {
        this.stores.persist();
      },
      upload: (trigger) => {
        this.uploader.upload(trigger);
      },
      scheduler,
      clock,
      lifecycle: test.lifecycle,
      network: test.network,
      log: this.log,
    });
    this.policy = new RetryPolicy({
      device: this.stores.device,
      pause: this.stores.pause,
      clock,
      random: test.random,
      log: this.log,
      config: snapshot,
    });
    this.uploader = new Uploader({
      chunks: this.chunks,
      http,
      config: snapshot,
      policy: this.policy,
      flags: this.flags,
      uploadsAllowed: () => page.privacy?.uploadsAllowed() ?? false,
      currentDeviceId: () => this.identity.deviceId,
      drops,
      persist: () => {
        this.stores.persist();
      },
      scheduler,
      clock,
      network: test.network,
      lifecycle: test.lifecycle,
      log: this.log,
    });
    this.privacy = new Privacy({
      keyHash: KEY_HASH,
      cookies: test.cookies,
      stores: this.stores,
      log: this.log,
      clock,
      defaultConsent: snapshot.defaultConsent,
      persistConsent: snapshot.persistConsent,
      secure,
      cookieDomain: () => options.domain,
      identity: this.identity,
      sessions: this.sessions,
      chunks: this.chunks,
      writer: this.writer,
      remote: this.remote,
      lifecycle: test.lifecycle,
      storageEvents: test.platform.storageEvents,
    });
    page.privacy = this.privacy;
    if (options.start !== false) this.start();
  }

  /** The start of the page as the factory will order it: consent first, then the writer and uploader. */
  start(): void {
    this.privacy.start();
    this.writer.start();
    this.uploader.start();
  }

  /** `track` as the public call makes it (Web Queue 1): consent, identity, session, the event. */
  track(name: string, properties: Record<string, unknown> = {}): void {
    if (!this.privacy.eventsAllowed()) return;
    const identity = this.identity.snapshot();
    this.enqueue(
      this.pipeline.capture({
        type: 'track',
        name,
        properties: properties as never,
        source: 'app',
        messageId: this.ids.next(),
        timestamp: this.test.clock.now(),
        visible: this.test.lifecycle.isVisible(),
        identity,
        callTime: this.pipeline.callTimeValues(),
      }),
    );
  }

  /** `identify` as the public call makes it. */
  identify(userId: string, traits: Record<string, unknown> = {}): void {
    this.privacy.state();
    const decision = this.identity.identify(userId, traits);
    if (decision?.kind !== 'send') return;
    this.enqueue(
      this.pipeline.capture({
        type: 'identify',
        traits: decision.traits,
        source: 'app',
        messageId: this.ids.next(),
        timestamp: this.test.clock.now(),
        visible: this.test.lifecycle.isVisible(),
        identity: decision.identity,
        callTime: this.pipeline.callTimeValues(),
      }),
    );
  }

  register(key: string, value: unknown): void {
    this.privacy.state();
    this.identity.register(key, value);
  }

  reset(): void {
    this.privacy.state();
    this.identity.reset();
  }

  /** `deviceId` as the public read gives it. */
  get deviceId(): string {
    this.privacy.state();
    return this.identity.deviceId;
  }

  /** Runs every slice and timer due now. */
  run(): void {
    this.test.scheduler.runUntilIdle();
  }

  /** Answers the next requests in order. */
  answer(...outcomes: (HttpOutcome | DelayedOutcome)[]): void {
    this.test.transport.enqueue(...outcomes);
  }

  /** The upload requests this page made. */
  get uploads(): readonly HttpRequest[] {
    return this.test.transport.requests.filter((request) => request.method === 'POST');
  }

  /** The configuration requests this page made. */
  get configRequests(): readonly HttpRequest[] {
    return this.test.transport.requests.filter((request) => request.method === 'GET');
  }

  /** The events of every upload, one list per request. */
  sent(): WireEvent[][] {
    return this.uploads.map((request) => (JSON.parse(request.body ?? '{}') as { batch: WireEvent[] }).batch);
  }

  /** Every event line stored under this key in `localStorage`, all pages' chunks. */
  stored(): WireEvent[] {
    const events: WireEvent[] = [];
    for (const [key, value] of this.test.storage.area.entries) {
      const parsed = parseQueueKey(key);
      if (parsed?.kind !== 'chunk' || parsed.name.keyHash !== KEY_HASH) continue;
      for (const text of value.split('\n')) if (text !== '') events.push(JSON.parse(text) as WireEvent);
    }
    return events;
  }

  /** Every `localStorage` key of the origin. */
  storageKeys(): string[] {
    return Array.from(this.test.storage.area.entries.keys()).sort();
  }

  /** The names of the cookies the browser holds. */
  cookieNames(): string[] {
    return this.test.cookies.store
      .cookies()
      .map((cookie) => cookie.name)
      .sort();
  }

  /** A cookie's value, `undefined` when it does not exist. */
  cookie(name: string): string | undefined {
    return this.test.cookies.store.cookies().find((cookie) => cookie.name === name)?.value;
  }

  /** A store record as stored, parsed; `undefined` when missing. */
  record(name: StoreName): Record<string, unknown> | undefined {
    const text = this.test.storage.area.entries.get(storeKey(KEY_HASH, name));
    return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
  }

  /** The `dropped` updates the observer received. */
  dropped(): EventUpdate[] {
    return this.updates.filter((update) => update.type === 'dropped');
  }

  private enqueue(prepared: PreparedEvent[]): void {
    this.writer.enqueue(prepared);
  }
}

/** A second page of the same browser, with its own configuration. */
export function otherPage(
  first: PrivacyPage,
  options: PrivacyPageOptions & { readonly host?: string } = {},
): PrivacyPage {
  const page = options.host === undefined ? {} : { host: options.host };
  const test = first.test.otherPage({ page });
  // Another host is another origin: its own storage (Web Privacy 2, point 3).
  return new PrivacyPage(options.host === undefined ? test : withOwnStorage(test), options);
}

function withOwnStorage(test: TestPlatform): TestPlatform {
  return new TestPlatform(
    { seed: test.random.seed, page: { host: test.cookies.host, secure: test.cookies.secure } },
    {
      clock: test.clock,
      scheduler: test.scheduler,
      storageArea: new MemoryStorageArea(),
      cookieStore: test.cookies.store,
      network: test.network,
    },
  );
}

/** The `privacy` group of the configuration. */
export function consentConfig(defaultConsent: 'granted' | 'pending', persistConsent = true): Record<string, unknown> {
  return { privacy: { defaultConsent, persistConsent } };
}
