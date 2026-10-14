// Configuration (step 3.1): the platform-neutral public types, the snapshot, the host rules and the
// validator (Configuration 1 to 5, Web Configuration 1, 4, 6).
export { FLUSH_AT, FLUSH_INTERVAL_MS, INACTIVITY_TIMEOUT_MS } from './config-snapshot';
export type { AppValues, ConfigSnapshot, LogSettings, NumericSetting } from './config-snapshot';
export { reportConfig, validateConfig } from './config-validator';
export type { ConfigEnvironment, ConfigIssue, ConfigValidation } from './config-validator';
export { checkHost, hostProblemText, hostSecurity } from './hosts';
export type { HostCheck, HostProblem, HostSecurity } from './hosts';
export { AUTOCAPTURE_TYPES, CONSENTS, DEFAULT_HOST } from './types';
export type {
  Autocapture,
  AutocaptureConfig,
  Consent,
  CoreConfig,
  CoreContextConfig,
  FlushConfig,
  LoggingConfig,
  NetworkConfig,
  PrivacyConfig,
} from './types';
