// The public surface of rubicon-analytics. Everything exported here is public API, recorded in
// etc/rubicon-analytics.api.md (Web Public API 7). Step 3.2 exports the types: the events and their
// context, the hook, the logging types and the configuration. Step 3.3 adds the `Analytics` interface
// and `createNoOpAnalytics`, the first runtime export; step 7.1 adds `createAnalytics`.

export { createAnalytics } from './create-analytics';
export { createNoOpAnalytics } from 'rubicon-analytics-core';

export type {
  Analytics,
  AppContext,
  Autocapture,
  AutocaptureConfig,
  BeforeSend,
  BrowserContext,
  Consent,
  ContextField,
  CoreConfig,
  CoreContextConfig,
  DeviceContext,
  DropReason,
  Event,
  EventContext,
  EventObserver,
  EventSource,
  EventUpdate,
  FlushConfig,
  IdentifyEvent,
  LibraryContext,
  LoggingConfig,
  LogLevel,
  NetworkConfig,
  OsContext,
  PageContext,
  PrivacyConfig,
  PropertyValue,
  RubiconLogger,
  ScreenContext,
  ScreenEvent,
  SessionContext,
  TrackEvent,
} from 'rubicon-analytics-core';
export type {
  AnalyticsConfig,
  AppConfig,
  ContextConfig,
  IdentityConfig,
  PageConfig,
  SessionConfig,
} from './analytics-config';
