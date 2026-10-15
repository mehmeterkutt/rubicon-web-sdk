import type { CoreConfig, CoreContextConfig } from 'rubicon-analytics-core';

// The public configuration of the browser SDK (Web Configuration 6): the platform-neutral groups of
// the core extended with the browser-only settings, each in the group of the block that owns it.
// Validated by the core's `validateConfig`, which knows every setting here. Exported from
// `src/index.ts` together with the types it names (plan section 15, step 3.1).

/** How sessions are measured (Web Session 1, 3). Held by `session`. */
export interface SessionConfig {
  /**
   * A session ends after this long without activity, in milliseconds, whether the site was visible
   * or hidden meanwhile. Default 1 800 000 (30 minutes); a whole number from 60 000 (one minute) to
   * 7 200 000 (two hours). A value out of bounds is clamped with a warning. The Android and iOS
   * `backgroundTimeoutMs` does not exist on the web: given anyway, it is not applied and a warning
   * names this setting.
   */
  readonly inactivityTimeoutMs?: number;
}

/**
 * `context.app`: the application's own description, which a page cannot read anywhere (Web Context
 * 3). A value not given is left out of the events.
 */
export interface AppConfig {
  /** `context.app.name`, such as `Shop`. */
  readonly name?: string;
  /** `context.app.version`, such as your release number. */
  readonly version?: string;
  /** `context.app.namespace`, a stable identifier of the application, such as `com.example.shop`. */
  readonly namespace?: string;
}

/** `context.page`: what the page group may carry besides its URL (Web Context 2). */
export interface PageConfig {
  /**
   * The query parameters copied into `context.page.query`, by name; no other parameter is ever
   * sent. Empty by default. Never name a parameter that can carry a token or personal data.
   *
   * @example
   * ```ts
   * context: { page: { queryParams: ['page', 'sort'] } }
   * ```
   */
  readonly queryParams?: readonly string[];
  /**
   * Whether `document.title` is sent as `context.page.title`. Default `false`: a title is displayed
   * text and may hold a user's name.
   */
  readonly title?: boolean;
}

/** What goes into each event's `context` (Context 6, Web Context 2, 3, 5). Held by `context`. */
export interface ContextConfig extends CoreContextConfig {
  /** The values of `context.app`. */
  readonly app?: AppConfig;
  /** The browser-only settings of `context.page`. */
  readonly page?: PageConfig;
}

/** Where the identity cookies live (Web Identity 2). Held by `identity`. */
export interface IdentityConfig {
  /**
   * Whether `device_id` and `user_id` are shared by the site's subdomains, through a cookie on the
   * registrable domain the browser accepts. Default `true`; `false` gives host-only cookies.
   */
  readonly crossSubdomain?: boolean;
  /**
   * An explicit cookie domain, such as `shop.example.com`, used instead of discovering one. It must
   * be the page's host name or a suffix of it; otherwise the cookies are host-only and a warning is
   * logged.
   */
  readonly cookieDomain?: string;
}

/**
 * Everything the SDK needs to start, handed to `createAnalytics` once (Configuration 2, Web
 * Configuration 1, 6). A plain object: only `apiKey` is required, a missing group or setting takes
 * its default, and a group given in part is completed from its defaults. The SDK copies what it
 * needs and keeps nothing of this object, so changing it afterwards changes nothing; behaviour that
 * changes at runtime goes through `Analytics` methods.
 *
 * A mistake never throws: a missing or blank key, or an invalid host, makes the SDK do nothing with an
 * error line; any other mistake is replaced by its default with a warning.
 *
 * @example
 * ```ts
 * const analytics = createAnalytics({
 *   apiKey: 'pk_live_...',
 *   debug: import.meta.env.DEV,
 *   flush: { immediateEvents: ['Purchase Completed'] },
 *   context: { app: { name: 'Shop', version: '4.2.0' } },
 * });
 * ```
 */
export interface AnalyticsConfig extends CoreConfig {
  /** How sessions are measured. */
  readonly session?: SessionConfig;
  /** What goes into each event's `context`. */
  readonly context?: ContextConfig;
  /** Where the identity cookies live. */
  readonly identity?: IdentityConfig;
}
