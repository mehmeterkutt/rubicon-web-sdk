import type { ConfigSnapshot } from '../config/config-snapshot';
import type { Consent } from '../config/types';
import type { HttpClient } from '../http/http-client';
import type { HttpResult } from '../http/http-result';
import { configRequest } from '../http/requests';
import type { Log } from '../log';
import type { Clock } from '../platform';
import type { ConsentDecision, RemoteConfigRecord, RemoteStore } from '../storage';
import { NO_REMOTE_CONFIG, parseRemoteBody, readRemoteConfig, restrictConfig } from './remote-config';
import type { RemoteConfig } from './remote-config';
import type { RuntimeFlags } from './runtime-flags';
import { isSampledIn } from './sampling';

/**
 * A page load requests the configuration only when the last successful fetch, of any page of the
 * origin, is older than this (Web Configuration 5). Internal, not remotely changeable.
 */
export const REMOTE_FETCH_INTERVAL_MS = 300_000;

/** Where consent stands for this page: the default, or a decision (Privacy 1, 4). */
export type RemoteConsent = Consent | ConsentDecision;

/** What the page runs with until the next page load. */
export interface EffectiveConfig {
  /** The code's configuration restricted by the saved remote values. */
  readonly snapshot: ConfigSnapshot;
  /** `false` when the kill switch is on or the device is outside `sample_rate`. */
  readonly collecting: boolean;
  /** Whether `SDK Diagnostics` is sent: on in code and inside `diagnostics_sample_rate`. */
  readonly sendsDiagnostics: boolean;
}

/** What a {@link RemoteConfigClient} is made of. */
export interface RemoteConfigClientOptions {
  /** The code's validated configuration. */
  readonly code: ConfigSnapshot;
  /** `.remote`, shared by the tabs of the origin. */
  readonly store: RemoteStore;
  readonly http: HttpClient;
  readonly flags: RuntimeFlags;
  readonly clock: Clock;
  readonly log: Log;
}

/**
 * Remote configuration on the web (Configuration 1, Web Configuration 5), the port of the Android
 * `RemoteConfigClient` with "launch" read as page load.
 *
 * - {@link startup} runs once per page load and gives the configuration the page runs with: the code
 *   restricted by the values saved in `.remote` by an earlier page load of any tab.
 * - {@link fetchIfDue} runs at page load and again after `optIn()`: `GET {host}/v1/config` with
 *   `If-None-Match`, in the background, at most once per page, and only when the saved record's
 *   `fetched_at` is more than five minutes old, so the tabs of an origin share one fetch. Never while
 *   consent is pending (nothing may be written, Web Privacy 1) or refused (nothing is sent, Web
 *   Logging 4), and never to a host the page blocks as mixed content (Web HTTP 3).
 * - A new answer is saved whole with its `ETag` and the fetch time, and applies from the next page
 *   load; only `enabled: false` and switching off `network_requests` apply at once
 *   ({@link RuntimeFlags}). A 304 keeps the values and records the fetch time. A 404 means no
 *   remote values and deletes the record, as Android does, so the next page load requests again;
 *   any other failure keeps the saved record, logs `REMOTE_CONFIG_FAILED` and leaves the next page
 *   load to try again. Nothing here stops the SDK or throws.
 */
export class RemoteConfigClient {
  private requested = false;
  private sawSavedValues = false;

  constructor(private readonly options: RemoteConfigClientOptions) {}

  /**
   * The configuration for this page load. `deviceId` is the one the page uses, a temporary one while
   * consent is pending (Web Privacy 1), when nothing of `.remote` is read and the code alone applies.
   */
  startup(deviceId: string): EffectiveConfig {
    const { code, flags, log } = this.options;
    const saved = this.savedRecord();
    this.sawSavedValues = saved !== undefined;
    const remote = saved === undefined ? NO_REMOTE_CONFIG : readRemoteConfig(saved.values, code, log);
    const snapshot = restrictConfig(code, remote);
    const sampled = isSampledIn(deviceId, remote.sampleRate ?? 1, 'events');
    const collecting = remote.enabled && sampled;
    const sendsDiagnostics =
      snapshot.sendDiagnostics && isSampledIn(deviceId, remote.diagnosticsSampleRate ?? 1, 'diagnostics');
    if (!collecting) flags.stopCollecting();
    if (!snapshot.autocapture.has('network_requests')) flags.stopCapturingNetworkRequests();
    if (!remote.enabled) log.info(() => 'Remote configuration has switched the SDK off; nothing is collected or sent');
    else if (!sampled) log.info(() => 'This device is outside the remote sample rate; nothing is collected or sent');
    return { snapshot, collecting, sendsDiagnostics };
  }

  /** Requests the configuration when it is due; see the class comment. */
  fetchIfDue(consent: RemoteConsent): void {
    const { code, clock, log } = this.options;
    if (consent !== 'granted') {
      log.debug(() => 'Remote configuration: no request while consent is pending or refused');
      return;
    }
    if (this.requested || code.hostSecurity === 'blocked') return;
    const saved = this.savedRecord();
    // A page that started while consent was pending could not read the saved values; their stop
    // flags apply now that it can, as a fetched answer's would (Configuration 1, rule 3).
    if (saved !== undefined && !this.sawSavedValues) {
      this.sawSavedValues = true;
      this.applyNow(readRemoteConfig(saved.values, code, log));
    }
    const fetchedAt = saved?.fetchedAt;
    if (fetchedAt !== undefined && !this.isDue(fetchedAt, clock.now())) {
      log.debug(() => 'Remote configuration fetched less than five minutes ago; not requested');
      return;
    }
    this.requested = true;
    const etag = saved?.etag;
    this.options.http.send(configRequest(code, etag), (result) => {
      this.onResult(result, etag);
    });
  }

  // Due when more than five minutes old; a time later than now means the clock was set back and
  // never holds the request back, since the kill switch must not wait for the clock to catch up.
  private isDue(fetchedAt: number, now: number): boolean {
    return fetchedAt > now || now - fetchedAt > REMOTE_FETCH_INTERVAL_MS;
  }

  private onResult(result: HttpResult, sentEtag: string | undefined): void {
    const { log } = this.options;
    switch (result.kind) {
      case 'success':
        if (result.status === 304) this.unchanged(sentEtag);
        else this.received(result.body, result.etag);
        return;
      case 'http-error':
        if (result.status === 404) {
          this.removeSaved();
          log.debug(() => 'No remote configuration for this key (404)');
        } else {
          this.failed(result.redirect === true ? 'a redirect' : `HTTP ${String(result.status)}`);
        }
        return;
      case 'network-failure':
        this.failed(result.failure);
        return;
      case 'keepalive-refused':
        this.failed('keepalive refused');
        return;
    }
  }

  private received(text: string | undefined, etag: string | undefined): void {
    const { code, clock, log } = this.options;
    const values = text === undefined ? undefined : parseRemoteBody(text);
    if (values === undefined) {
      this.failed('the response is not a JSON object');
      return;
    }
    this.save({ etag, values, fetchedAt: clock.now() });
    this.applyNow(readRemoteConfig(values, code, log));
    log.debug(() => 'Remote configuration saved; it applies at the next page load');
  }

  // The saved values stay; the fetch time moves so the other tabs wait five minutes as well. A
  // record another page replaced meanwhile is left as it is.
  private unchanged(sentEtag: string | undefined): void {
    const saved = this.savedRecord();
    if (saved !== undefined && saved.etag === sentEtag) this.save({ ...saved, fetchedAt: this.options.clock.now() });
    this.options.log.debug(() => 'Remote configuration unchanged');
  }

  // Written whole (Web Disk 3); while consent is pending or refused, or the record is unreadable,
  // the store holds it in memory and writes nothing (Web Logging 4, Disk 7).
  private save(record: RemoteConfigRecord): void {
    this.options.store.save(record);
  }

  // A 404 deletes the saved values (Android log 5.3, confirmed for the web by the user on
  // 2026-10-15). Only a readable record is deleted: one this SDK cannot read, such as a newer
  // version's, is left as it is (Disk 7, Web Disk 5). While consent is pending or refused the store
  // touches nothing (Web Logging 4).
  private removeSaved(): void {
    if (this.options.store.read().status === 'present') this.options.store.remove();
  }

  private savedRecord(): RemoteConfigRecord | undefined {
    const read = this.options.store.read();
    return read.status === 'present' ? read.state : undefined;
  }

  private applyNow(remote: RemoteConfig): void {
    const { flags, log } = this.options;
    if (!remote.enabled && flags.collecting) {
      flags.stopCollecting();
      log.info(() => 'Remote configuration switched the SDK off; collection and uploads stop now');
    }
    if (remote.autocaptureOff.has('network_requests') && flags.capturingNetworkRequests) {
      flags.stopCapturingNetworkRequests();
      log.info(() => 'Remote configuration switched off network request capture');
    }
  }

  private failed(reason: string): void {
    this.options.log.warn(
      'REMOTE_CONFIG_FAILED',
      () => `Could not fetch the remote configuration (${reason}); the last valid values are kept`,
    );
  }
}
