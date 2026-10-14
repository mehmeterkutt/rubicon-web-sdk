import type { ContextField } from '../context/context-field';

/** `context.device.type` on the web: best effort, absent when no signal tells (Web Context 1). */
export type DeviceType = 'phone' | 'tablet' | 'desktop';

/**
 * The fields a provider never reads, named by their wire paths, such as `page.url` (Context 6, Web
 * Context 5).
 */
export type DisabledContextFields = ReadonlySet<ContextField>;

/**
 * The values that do not change during a page load, read once, lazily, at the first call; never at
 * import or in the factory (Web Context 4). A value the browser does not give is absent. `app` and
 * `library` come from the configuration and the build, not from the provider (Web Context 3).
 */
export interface StaticContextValues {
  readonly osName?: string;
  readonly browserName?: string;
  /** The major version only. */
  readonly browserVersion?: string;
  readonly deviceType?: DeviceType;
  /** CSS pixels, the short side first (Web Context 3). */
  readonly screenWidth?: number;
  readonly screenHeight?: number;
  /** `devicePixelRatio`. */
  readonly screenDensity?: number;
  /** Once per page load: `document.referrer` does not change with `pushState` (Web Context 4). */
  readonly pageReferrer?: string;
}

/** The values read inside every public call, so an event carries those of its own moment. */
export interface CallTimeContextValues {
  /** Origin and path, ids masked, no query or fragment (Web Context 2). */
  readonly pageUrl?: string;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  /** Only the parameters named in `context.page.queryParams`; absent when none is present. */
  readonly pageQuery?: Readonly<Record<string, string>>;
  /** Only with `context.page.title: true`. */
  readonly pageTitle?: string;
  /** `navigator.language`. */
  readonly locale?: string;
  /** The IANA zone from `Intl`. */
  readonly timezone?: string;
}

/** What a call-time read needs from the configuration (Web Context 2, 5). */
export interface CallTimeContextRequest {
  readonly disabled: DisabledContextFields;
  readonly queryParams: readonly string[];
  readonly title: boolean;
}

/**
 * Supplies the browser part of `context` (Context 1, 2; Web Context 1 to 4). A disabled field is
 * never read, not merely left out (Context 6). Every read is a cheap property read and must not
 * throw. Step 7.5 implements it and may refine these shapes.
 */
export interface ContextProvider {
  staticValues(disabled: DisabledContextFields): StaticContextValues;

  callTimeValues(request: CallTimeContextRequest): CallTimeContextValues;
}
