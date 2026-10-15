// Remote configuration (step 5.3): the port of the Android `internal/remote` package with "launch"
// read as page load, the five-minute interval shared by the tabs, and no request while consent is
// pending or refused (Configuration 1, Web Configuration 5, Web Privacy 1, Web Logging 4).
export { NO_REMOTE_CONFIG, parseRemoteBody, readRemoteConfig, restrictConfig } from './remote-config';
export type { RemoteConfig } from './remote-config';
export { REMOTE_FETCH_INTERVAL_MS, RemoteConfigClient } from './remote-config-client';
export type { EffectiveConfig, RemoteConfigClientOptions, RemoteConsent } from './remote-config-client';
export { RuntimeFlags } from './runtime-flags';
export { isSampledIn, samplingBucket } from './sampling';
export type { SamplingPurpose } from './sampling';
