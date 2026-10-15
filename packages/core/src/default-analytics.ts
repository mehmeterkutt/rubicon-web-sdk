import type { Analytics } from './analytics';
import type { AutomaticCapture, CaptureMoment } from './automatic-capture';
import type { ConfigSnapshot } from './config/config-snapshot';
import type { Autocapture } from './config/types';
import { DiagnosticsReporter } from './diagnostics/diagnostics';
import type { EventSource } from './event/event';
import { HttpClient } from './http/http-client';
import { Identity } from './identity/identity';
import type { IdentitySnapshot } from './identity/identity';
import type { Log } from './log/log';
import type { DropReason } from './log/types';
import type {
  HttpTransport,
  LifecycleEvent,
  PageLocation,
  Platform,
  ScheduledTask,
  Scheduler,
  Unsubscribe,
} from './platform';
import { EventPipeline } from './pipeline/event-pipeline';
import type { CapturedEvent, PreparedEvent } from './pipeline/event-pipeline';
import { Writer } from './pipeline/writer';
import type { WriterSettings } from './pipeline/writer';
import { Privacy } from './privacy/privacy';
import { ADOPT_AFTER_MS, Uploader } from './queue/uploader';
import { RemoteConfigClient } from './remote/remote-config-client';
import type { EffectiveConfig } from './remote/remote-config-client';
import { RuntimeFlags } from './remote/runtime-flags';
import { RetryPolicy } from './retry/retry-policy';
import { SessionManager } from './session/session-manager';
import type { SessionEvent } from './session/session-manager';
import type { ChunkInfo, DropCounter } from './storage/chunk-store';
import { ChunkStore } from './storage/chunk-store';
import { CookieDomain, SiteCookies } from './storage/cookie-domain';
import { probeKey } from './storage/storage-probe';
import { identityCookieName } from './identity/identity-cookie';
import { sessionCookieName } from './session/session-cookie';
import { consentCookieName } from './privacy/consent-cookie';
import { Stores } from './storage/stores';
import { keyHash } from './util/hashing';
import { UuidV7Generator } from './util/uuid-v7-generator';
import { checkName, normalizeProperties } from './validation/property-normalizer';
import { reportPropertyProblems } from './validation/property-problem';

/** A capture to start with the instance, when its gate is in the configuration the page runs with. */
interface StartHook {
  readonly gate: Autocapture;
  readonly start: () => Unsubscribe | undefined;
}

/** What every event of one call shares. */
type CallFields = Pick<CapturedEvent, 'source' | 'messageId' | 'timestamp' | 'visible' | 'identity' | 'callTime'>;

/** How often {@link DefaultAnalytics.flushAndWait} looks again; tests only. */
const POLL_MS = 10;

/** What the core factory adds to the `Platform` for one instance; every member has a default. */
export interface CoreOptions {
  /**
   * The read half of the start probe of Web Disk 4 (`storageReadable` over `localStorage`, step
   * 7.2), asked once when the instance starts, before consent is read: `false`, or a throw, selects
   * the memory-only mode with one `STORAGE_UNAVAILABLE` WARN. Storage is taken as usable unless given.
   */
  readonly storageUsable?: () => boolean;
  /**
   * The write half of that probe (step 7.2): an empty value under the given key written, read back
   * and removed, asked once at start only when the page starts with consent granted; `false`, or a
   * throw, selects the memory-only mode as the read half does. Not asked unless given.
   */
  readonly storageWritable?: (key: string) => boolean;
  /**
   * Called once with the automatic capture of a newly created instance, never for the no-op, so
   * `web` attaches page views and network capture (Android `RubiconCore.create`'s `onCreated`).
   */
  readonly onCreated?: (capture: AutomaticCapture) => void;
  /**
   * Watches the page's Content Security Policy violations for the SDK's requests (Web HTTP 3, step
   * 7.3): called once when the instance starts with the two endpoint URLs, it calls `onBlocked` for
   * every enforced `connect-src` violation of one of them, and returns how to stop watching. The
   * core logs `CSP_BLOCKED` and never reclassifies the request, which stays `io`. Nothing is watched
   * unless given.
   */
  readonly watchPolicyViolations?: (endpoints: readonly string[], onBlocked: () => void) => Unsubscribe;
}

/** What a {@link DefaultAnalytics} is made of: the validated configuration, the platform, the log. */
export interface DefaultAnalyticsParts {
  readonly code: ConfigSnapshot;
  readonly platform: Platform;
  /** Made by the factory first, so the configuration issues are logged before anything else. */
  readonly log: Log;
  readonly options: CoreOptions;
}

/**
 * The real {@link Analytics} (Public API 2, Web Public API 1, 3), the port of the Android
 * `DefaultAnalytics`, wired over the components of steps 4.1 to 6.6. The public object is
 * {@link analytics}; this class holds the state behind it.
 *
 * - The public call does the cheap steps (Web Queue 1): the consent decision read first (Web Privacy
 *   2, point 2), the name and property checks, the identity, the session and the context of that
 *   moment, then one message to the writer. It never waits and never throws.
 * - Nothing is read in the factory: the instance starts at its first use, the first public call or
 *   the first task the scheduler runs, whichever comes first (Web Identity 1: the probes run at first
 *   use; Web Public API 7). Starting reads the consent decision before anything else touches storage
 *   (step 6.5), takes the configuration the page runs with from the saved remote values (Configuration
 *   1, Web Configuration 5), evaluates the session at page load (Web Session 1), starts the writer
 *   and the uploader and asks for the remote configuration when it is due.
 * - Every entry point, listener and scheduled task catches what it does not expect and logs
 *   `WORKER_FAILED`: a failure is an analytics gap, not a broken page (root `CLAUDE.md`,
 *   non-negotiable 1). `debug` never throws (Web Public API 4).
 * - The public object's methods are its own properties and never read `this`, so a method taken off
 *   the instance (`button.onclick = analytics.flush`) or a spread of it still works.
 */
export class DefaultAnalytics {
  /** The object handed to the developer. */
  readonly analytics: Analytics;
  /** The automatic capture `web` attaches to (steps 7.6, 7.7). */
  readonly capture: AutomaticCapture;

  readonly stores: Stores;
  readonly chunks: ChunkStore;
  readonly identity: Identity;
  readonly sessions: SessionManager;
  readonly pipeline: EventPipeline;
  readonly writer: Writer;
  readonly uploader: Uploader;
  readonly remote: RemoteConfigClient;
  readonly privacy: Privacy;
  readonly flags = new RuntimeFlags();

  private readonly code: ConfigSnapshot;
  private readonly platform: Platform;
  private readonly log: Log;
  private readonly options: CoreOptions;
  private readonly ids: UuidV7Generator;
  private readonly siteCookies: SiteCookies;
  private readonly keyHash: string;
  private readonly sdkHost: string;
  // The configuration the page runs with, set when it starts (Configuration 1, Web Configuration 5).
  private effective: EffectiveConfig | undefined;
  private phase: 'new' | 'started' | 'stopped' = 'new';
  private startTask: ScheduledTask | undefined;
  private unsubscribes: Unsubscribe[] = [];
  private startHooks: StartHook[] = [];

  constructor(parts: DefaultAnalyticsParts) {
    const { code, platform, log, options } = parts;
    this.code = code;
    this.platform = platform;
    this.log = log;
    this.options = options;
    const { clock, random, storage, lifecycle, network, urls } = platform;
    // Every timer and every answer of the transport runs behind a catch (root `CLAUDE.md`,
    // non-negotiable 1): a throw below one is an analytics gap, logged, never an error in the page.
    const fail = (error: unknown): void => {
      this.failed(error);
    };
    const scheduler = guardedScheduler(platform.scheduler, fail);
    const transport = guardedTransport(platform.transport, fail);
    const hash = keyHash(code.apiKey);
    this.keyHash = hash;
    const secure = platform.pageScheme === 'https';
    // Decided at the first cookie the instance writes or deletes (Web Identity 2).
    const domain = new CookieDomain({
      cookies: platform.cookies,
      host: platform.pageHost,
      secure,
      crossSubdomain: code.crossSubdomain,
      cookieDomain: code.cookieDomain,
      probeId: () => this.ids.next(),
      log,
    });
    const cookieDomain = (): string | undefined => domain.domain();
    // One scope per cookie name for what the components write (plan section 15, step 7.2).
    this.siteCookies = new SiteCookies({
      cookies: platform.cookies,
      host: platform.pageHost,
      domain: cookieDomain,
      names: [identityCookieName(hash), sessionCookieName(hash), consentCookieName(hash)],
    });
    const cookies = this.siteCookies;

    this.stores = new Stores({ keyHash: hash, storage, log, clock });
    const stores = this.stores;
    const drops: DropCounter = {
      count: (reason: DropReason, events: number) => {
        stores.device.countDropped(reason, events);
      },
    };
    this.chunks = new ChunkStore({ keyHash: hash, storage, access: stores.access, log, clock, random, drops });
    this.ids = new UuidV7Generator(clock, random);
    this.sessions = new SessionManager({
      keyHash: hash,
      cookies,
      clock,
      ids: this.ids,
      log,
      inactivityTimeoutMs: code.inactivityTimeoutMs,
      emitEvents: () => this.runsWith().autocapture.has('sessions'),
      secure,
      cookieDomain,
      accessLevel: () => stores.accessLevel,
    });
    this.pipeline = new EventPipeline({
      config: code,
      context: platform.context,
      sessions: this.sessions,
      ids: this.ids,
      log,
    });
    this.identity = new Identity({
      keyHash: hash,
      cookies,
      stores,
      log,
      ids: this.ids,
      random,
      secure,
      cookieDomain,
      eventsAllowed: () => this.privacy.eventsAllowed(),
      refused: () => this.privacy.refused(),
      requestPersist: () => {
        this.writer.requestPersist();
      },
      onPersonCleared: (previous) => {
        this.onPersonCleared(previous);
      },
    });
    const http = new HttpClient({ transport, scheduler, clock, network, urls, log });
    this.remote = new RemoteConfigClient({ code, store: stores.remote, http, flags: this.flags, clock, log });
    const diagnostics = new DiagnosticsReporter({
      device: stores.device,
      access: stores.access,
      pipeline: this.pipeline,
      identity: () => this.identity.snapshot(),
      ids: this.ids,
      visible: () => lifecycle.isVisible(),
      clock,
      log,
    });
    this.writer = new Writer({
      pipeline: this.pipeline,
      chunks: this.chunks,
      startup: () => this.writerSettings(),
      flags: this.flags,
      eventsAllowed: () => this.privacy.eventsAllowed(),
      currentDeviceId: () => this.identity.deviceId,
      drops,
      diagnostics,
      persist: () => {
        stores.persist();
      },
      upload: (trigger) => {
        this.uploader.upload(trigger);
      },
      scheduler,
      clock,
      lifecycle,
      network,
      log,
    });
    const policy = new RetryPolicy({ device: stores.device, pause: stores.pause, clock, random, log, config: code });
    this.uploader = new Uploader({
      chunks: this.chunks,
      http,
      config: code,
      policy,
      flags: this.flags,
      uploadsAllowed: () => this.privacy.uploadsAllowed(),
      // A temporary id holds the upload rather than deleting stored chunks as another device's
      // (plan section 15, step 6.4, the user's answer 3).
      currentDeviceId: () => this.identity.confirmedDeviceId(),
      drops,
      persist: () => {
        stores.persist();
      },
      scheduler,
      clock,
      network,
      lifecycle,
      log,
    });
    this.privacy = new Privacy({
      keyHash: hash,
      cookies,
      stores,
      log,
      clock,
      defaultConsent: code.defaultConsent,
      persistConsent: code.persistConsent,
      secure,
      cookieDomain,
      identity: this.identity,
      sessions: this.sessions,
      chunks: this.chunks,
      writer: this.writer,
      remote: this.remote,
      lifecycle,
      storageEvents: platform.storageEvents,
    });
    this.sdkHost = urls.parse(code.host)?.hostname ?? '';
    this.analytics = exposed(this);
    this.capture = automaticCapture(this);
    // The start of a page that makes no call comes after the factory has returned (Web Queue 1).
    this.startTask = scheduler.yield(() => {
      this.guarded(() => {
        this.start();
      });
    });
  }

  // The public calls (Web Public API 3), each behind `entry`: started first, nothing thrown.

  track(name: unknown, properties: unknown): void {
    this.entry(() => {
      this.record('track', name, properties);
    });
  }

  screen(name: unknown, properties: unknown): void {
    this.entry(() => {
      this.record('screen', name, properties);
    });
  }

  identify(userId: unknown, traits: unknown): void {
    this.entry(() => {
      this.privacy.state();
      const decision = this.identity.identify(userId, traits);
      // Not while switched off remotely (Configuration 1); the identity decides consent (Privacy 1).
      if (decision?.kind !== 'send' || !this.flags.collecting) return;
      this.enqueue(
        this.pipeline.capture({
          type: 'identify',
          traits: decision.traits,
          oversize: decision.traitsOversize,
          ...this.callFields('app', decision.identity),
        }),
      );
    });
  }

  reset(): void {
    this.entry(() => {
      this.privacy.state();
      this.identity.reset();
    });
  }

  register(key: unknown, value: unknown): void {
    this.entry(() => {
      this.privacy.state();
      this.identity.register(key, value);
    });
  }

  unregister(key: unknown): void {
    this.entry(() => {
      this.privacy.state();
      this.identity.unregister(key);
    });
  }

  flush(): void {
    this.entry(() => {
      this.privacy.state();
      this.writer.flush();
    });
  }

  optOut(): void {
    this.entry(() => {
      this.privacy.optOut();
    });
  }

  optIn(): void {
    this.entry(() => {
      this.privacy.optIn();
    });
  }

  clearLocalData(): void {
    this.entry(() => {
      this.privacy.clearLocalData();
    });
  }

  /** `isOptedOut`; `false` when reading it failed, as on Android. */
  get isOptedOut(): boolean {
    return this.read(() => this.privacy.isOptedOut(), false);
  }

  /** `deviceId`; the empty string, the no-op's, when reading it failed. */
  get deviceId(): string {
    return this.read(() => {
      this.privacy.state();
      return this.identity.deviceId;
    }, '');
  }

  /** {@link AutomaticCapture.track}. */
  trackAutomatic(gate: Autocapture, name: unknown, properties: unknown, moment?: CaptureMoment): void {
    this.entry(() => {
      const allowed = this.privacy.eventsAllowed();
      const checked = checkName(name);
      if (!checked.valid) {
        // The SDK made the name: a WARN, never the developer-error form (Android log 7.1).
        this.log.warn('INVALID_EVENT_NAME', () => `An automatic event of ${gate} has an invalid name; it was dropped`);
        return;
      }
      if (!allowed || !this.flags.collecting || !this.isEffective(gate)) return;
      const normalized = normalizeProperties(properties);
      reportPropertyProblems(normalized.problems, this.log);
      this.enqueue(
        this.pipeline.capture({
          type: 'track',
          name: checked.name,
          properties: normalized.values,
          oversize: normalized.oversize,
          ...this.callFields('auto', this.identity.snapshot(), moment),
        }),
      );
    });
  }

  /**
   * {@link AutomaticCapture.moment}: the clock, the visibility and the call-time context of now, read
   * without starting the instance.
   */
  momentOf(page?: PageLocation): CaptureMoment | undefined {
    try {
      return {
        time: this.platform.clock.now(),
        visible: this.platform.lifecycle.isVisible(),
        callTime: this.pipeline.callTimeValues(page),
      };
    } catch (error) {
      this.failed(error);
      return undefined;
    }
  }

  /** {@link AutomaticCapture.configures}. */
  configures(gate: Autocapture): boolean {
    return this.code.autocapture.has(gate);
  }

  /** {@link AutomaticCapture.onStart}; a hook given after the start is not called. */
  onStart(gate: Autocapture, start: () => Unsubscribe | undefined): void {
    if (this.phase === 'new') this.startHooks.push({ gate, start });
  }

  /** {@link AutomaticCapture.capturesNetworkRequests}. */
  get capturesNetworkRequests(): boolean {
    return this.read(() => {
      this.ensureStarted();
      return this.isEffective('network_requests') && this.flags.collecting && this.privacy.eventsAllowed();
    }, false);
  }

  /** {@link AutomaticCapture.now}. */
  now(): number {
    return this.platform.clock.now();
  }

  /** {@link AutomaticCapture.sdkHost}. */
  get host(): string {
    return this.sdkHost;
  }

  /** The instance's log, for {@link AutomaticCapture.log}. */
  get logger(): Log {
    return this.log;
  }

  /**
   * Asks for a flush and resolves once nothing this page can send is waiting (its own chunks and
   * other pages' released or aged ones, Web Queue 2) and the writer and the uploader are idle:
   * `true`; `false` when `timeoutMs` passed first. Polls on the platform's scheduler, so it waits in
   * real time only on a real scheduler. For tests only, never public (Public API 9, Android log 6.7).
   */
  flushAndWait(timeoutMs: number): Promise<boolean> {
    const { clock, scheduler } = this.platform;
    this.flush();
    // Polled on the platform's own scheduler: a test helper, outside the guarded one.
    const deadline = clock.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = (): void => {
        if (this.settledSafely()) resolve(true);
        else if (clock.now() >= deadline) resolve(false);
        else scheduler.after(POLL_MS, poll);
      };
      scheduler.after(0, poll);
    });
  }

  /**
   * Stops the instance: the writer, the uploader and every listener, so a test can open another
   * page over the same storage. A request in flight still completes. For tests only.
   */
  shutdown(): void {
    this.guarded(() => {
      this.phase = 'stopped';
      this.startTask?.cancel();
      this.unsubscribes.forEach((unsubscribe) => {
        unsubscribe();
      });
      this.unsubscribes = [];
      this.writer.stop();
      this.uploader.stop();
      this.privacy.stop();
    });
  }

  // Starts the instance once, at its first use.
  private ensureStarted(): void {
    if (this.phase === 'new') this.start();
  }

  private start(): void {
    if (this.phase !== 'new') return;
    this.phase = 'started';
    this.startTask?.cancel();
    this.selectStorageMode();
    // Before anything else reads storage (plan section 15, step 6.5).
    this.privacy.start();
    this.probeWrites();
    // Cookies of one name in two scopes leave the page's reads and writes apart (step 7.2).
    if (this.stores.accessLevel === 'full') this.siteCookies.cleanUp(this.platform.pageScheme === 'https');
    // Asked once per page load; sets the kill switch and the network capture switch (step 5.3).
    this.effective = this.remote.startup(this.identity.deviceId);
    // Before the lifecycle subscriptions below, so an automatic capture hears a hiding first.
    this.startAutomaticCapture();
    const { lifecycle } = this.platform;
    this.unsubscribes.push(
      lifecycle.subscribe((event) => {
        this.guarded(() => {
          this.onLifecycle(event);
        });
      }),
    );
    this.watchPolicyViolations();
    this.writer.start();
    this.uploader.start();
    // The end of a session found at page load (Web Session 1, Session 5).
    if (this.privacy.eventsAllowed() && this.flags.collecting) {
      const identity = this.identity.snapshot();
      this.enqueueSessionEvents(this.sessions.start(identity.personEpoch), identity);
    }
    // At page load, under the five-minute rule; never while pending or refused (Web Configuration 5).
    this.remote.fetchIfDue(this.privacy.state());
  }

  // The captures `web` attached (page views, step 7.6), each only when its gate is in the configuration
  // the page runs with (Web Lifecycle 8); a throw costs that capture only.
  private startAutomaticCapture(): void {
    const hooks = this.startHooks;
    this.startHooks = [];
    for (const hook of hooks) {
      if (!this.runsWith().autocapture.has(hook.gate)) continue;
      this.guarded(() => {
        const stop = hook.start();
        if (stop !== undefined) this.unsubscribes.push(stop);
      });
    }
  }

  // A Content Security Policy that blocks the host is diagnosed only, once per page: the violation
  // arrives as a separate task and cannot be tied to one request, so the request stays `io` (Web HTTP
  // 3). The line names the host, never the blocked URL.
  private watchPolicyViolations(): void {
    const watch = this.options.watchPolicyViolations;
    if (watch === undefined) return;
    const host = this.sdkHost;
    // The platform's code: a throw here costs the diagnosis only, never the start.
    this.guarded(() => {
      this.unsubscribes.push(
        watch([this.code.batchUrl, this.code.configUrl], () => {
          this.guarded(() => {
            this.log.error(
              'CSP_BLOCKED',
              () => `The page's Content Security Policy blocked a request to ${host}; allow its origin in connect-src`,
            );
          });
        }),
      );
    });
  }

  // The memory-only mode of Web Disk 4, chosen once per page by the platform's start probe: its read
  // half before consent is known, so a page that cannot read storage starts in memory.
  private selectStorageMode(): void {
    if (!this.passes(this.options.storageUsable)) this.useMemoryOnly();
  }

  // The write half, only for a page that starts with consent granted: a pending or refused page
  // writes nothing (Web Privacy 1, Web Logging 4; plan section 15, step 7.2, the user's answer 3).
  private probeWrites(): void {
    const probe = this.options.storageWritable;
    if (probe === undefined || this.stores.accessLevel !== 'full' || this.privacy.state() !== 'granted') return;
    if (!this.passes(() => probe(probeKey(this.keyHash)))) this.useMemoryOnly();
  }

  // A probe that throws is storage that cannot be used; no probe is storage taken as usable.
  private passes(probe: (() => boolean) | undefined): boolean {
    if (probe === undefined) return true;
    try {
      return probe();
    } catch {
      return false;
    }
  }

  private useMemoryOnly(): void {
    this.stores.accessLevel = 'none';
    this.log.warn('STORAGE_UNAVAILABLE', () => 'Storage cannot be used; the SDK runs from memory on this page');
  }

  // A tab becoming visible finds a session's end, the other events are activity (Web Session 1, 4).
  private onLifecycle(event: LifecycleEvent): void {
    if (this.phase !== 'started' || !this.privacy.eventsAllowed() || !this.flags.collecting) return;
    const identity = this.identity.snapshot();
    this.enqueueSessionEvents(this.sessions.onLifecycle(event, identity.personEpoch), identity);
  }

  // `reset()` or another user: the session ends with the previous person's identity first (Web
  // Session 5); no event while refused or switched off.
  private onPersonCleared(previous: IdentitySnapshot): void {
    const ended = this.sessions.onPersonCleared(previous, this.platform.lifecycle.isVisible());
    if (this.privacy.refused() || !this.flags.collecting) return;
    this.enqueueSessionEvents(ended, previous);
  }

  private enqueueSessionEvents(events: readonly SessionEvent[], identity: IdentitySnapshot): void {
    if (events.length === 0) return;
    this.enqueue(this.pipeline.sessionEvents(events, identity, this.pipeline.callTimeValues()));
  }

  // `track` and `screen` (Public API 4): the name first, as Android, then nothing more while
  // refused or switched off (Privacy 1, Configuration 1).
  private record(type: 'track' | 'screen', name: unknown, properties: unknown): void {
    const allowed = this.privacy.eventsAllowed();
    const checked = checkName(name);
    if (!checked.valid) {
      reportPropertyProblems([checked.problem], this.log);
      return;
    }
    if (!allowed || !this.flags.collecting) return;
    const normalized = normalizeProperties(properties);
    reportPropertyProblems(normalized.problems, this.log);
    this.enqueue(
      this.pipeline.capture({
        type,
        name: checked.name,
        properties: normalized.values,
        oversize: normalized.oversize,
        ...this.callFields('app', this.identity.snapshot()),
      }),
    );
  }

  // What every event of a call shares: its id, time, visibility, identity and context of now, or of
  // the moment an automatic event was read at (Web Lifecycle 2, Web Session 5).
  private callFields(source: EventSource, identity: IdentitySnapshot, moment?: CaptureMoment): CallFields {
    const { clock, lifecycle } = this.platform;
    return {
      source,
      messageId: this.ids.next(),
      timestamp: moment?.time ?? clock.now(),
      visible: moment?.visible ?? lifecycle.isVisible(),
      identity,
      callTime: moment?.callTime ?? this.pipeline.callTimeValues(),
    };
  }

  private enqueue(prepared: PreparedEvent[]): void {
    this.writer.enqueue(prepared);
  }

  // The configuration the page runs with; the code's until the instance has started.
  private runsWith(): ConfigSnapshot {
    return this.effective?.snapshot ?? this.code;
  }

  private writerSettings(): WriterSettings {
    this.ensureStarted();
    const effective = this.effective;
    const snapshot = this.runsWith();
    return { ...snapshot, sendsDiagnostics: effective?.sendsDiagnostics ?? snapshot.sendDiagnostics };
  }

  // A gate of automatic capture (Web Lifecycle 8): the saved remote values from this page load on,
  // `network_requests` also switched off at once.
  private isEffective(gate: Autocapture): boolean {
    if (!this.runsWith().autocapture.has(gate)) return false;
    return gate !== 'network_requests' || this.flags.capturingNetworkRequests;
  }

  private settledSafely(): boolean {
    try {
      return this.settled();
    } catch {
      return false;
    }
  }

  // Nothing this page could send is waiting, and nothing is running.
  private settled(): boolean {
    if (!this.writer.idle || this.uploader.busy) return false;
    const now = this.platform.clock.now();
    const walked = this.chunks.walk() ?? [];
    return !walked.some((chunk) => sendable(chunk, now));
  }

  private entry(action: () => void): void {
    this.guarded(() => {
      this.ensureStarted();
      action();
    });
  }

  private read<T>(value: () => T, fallback: T): T {
    try {
      this.ensureStarted();
      return value();
    } catch (error) {
      this.failed(error);
      return fallback;
    }
  }

  private guarded(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.failed(error);
    }
  }

  // Never crash the host app (root `CLAUDE.md`, non-negotiable 1); the error only as the logger's
  // argument (Web Logging 1).
  private failed(error: unknown): void {
    try {
      this.log.error('WORKER_FAILED', () => 'A call failed; it was ignored', { error });
    } catch {
      // The log itself failed: nothing more can be said without risking the page.
    }
  }
}

// The platform's scheduler with every task run behind a catch.
function guardedScheduler(scheduler: Scheduler, fail: (error: unknown) => void): Scheduler {
  const guard =
    (task: () => void): (() => void) =>
    () => {
      try {
        task();
      } catch (error) {
        fail(error);
      }
    };
  return {
    after: (delayMs, task) => scheduler.after(delayMs, guard(task)),
    yield: (task) => scheduler.yield(guard(task)),
  };
}

// The platform's transport with its answer handled behind a catch; `send` and `abort` are the
// caller's to guard, as `HttpClient` does.
function guardedTransport(transport: HttpTransport, fail: (error: unknown) => void): HttpTransport {
  return {
    send: (request, onOutcome) =>
      transport.send(request, (outcome) => {
        try {
          onOutcome(outcome);
        } catch (error) {
          fail(error);
        }
      }),
  };
}

// A chunk the uploader of this page would take (Web Queue 2): its own, or another page's released
// or aged one.
function sendable(chunk: ChunkInfo, now: number): boolean {
  return chunk.own || chunk.released || now - chunk.writtenAt >= ADOPT_AFTER_MS;
}

// The object handed to the developer: a plain object whose methods are its own properties and close
// over `core` rather than reading `this` (Web Public API 3, like `createNoOpAnalytics`). The two reads
// are getters, so they read fresh at every access (Web Identity 3).
function exposed(core: DefaultAnalytics): Analytics {
  return {
    track(name, properties) {
      core.track(name, properties);
    },
    screen(name, properties) {
      core.screen(name, properties);
    },
    identify(userId, traits) {
      core.identify(userId, traits);
    },
    reset() {
      core.reset();
    },
    register(key, value) {
      core.register(key, value);
    },
    unregister(key) {
      core.unregister(key);
    },
    flush() {
      core.flush();
    },
    optOut() {
      core.optOut();
    },
    optIn() {
      core.optIn();
    },
    get isOptedOut() {
      return core.isOptedOut;
    },
    clearLocalData() {
      core.clearLocalData();
    },
    get deviceId() {
      return core.deviceId;
    },
  };
}

function automaticCapture(core: DefaultAnalytics): AutomaticCapture {
  return {
    track(gate, name, properties, moment) {
      core.trackAutomatic(gate, name, properties, moment);
    },
    moment(page) {
      return core.momentOf(page);
    },
    configures(gate) {
      return core.configures(gate);
    },
    onStart(gate, start) {
      core.onStart(gate, start);
    },
    get capturesNetworkRequests() {
      return core.capturesNetworkRequests;
    },
    now() {
      return core.now();
    },
    get sdkHost() {
      return core.host;
    },
    get log() {
      return core.logger;
    },
  };
}
