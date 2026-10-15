// What the SDK measured when an event was created (Event Model 1, Context 3 and 4; Web Event Model
// 1; Web Context 1 to 5): readonly groups, the Android ones without `network` plus the browser's
// `browser` and `page`. Each group is always there; a value the browser does not give, or a field
// switched off with `context.disabledFields`, is `undefined` and left out of the wire, and a group
// with no value is left out as a whole (Android log 3.2).

/**
 * What the SDK measured when an event was created. Hooks can read it but never change it: a hook
 * result whose `context` differs from its input's is not accepted (Context 4, Web Public API 5). A
 * field that must not be sent is switched off with `context.disabledFields`.
 *
 * @example
 * ```ts
 * const dropBots: BeforeSend = (event) => (event.context.browser.name === 'HeadlessChrome' ? null : event);
 * ```
 */
export interface EventContext {
  /** The application, as `context.app` in the configuration describes it. */
  readonly app: AppContext;
  /** The device. */
  readonly device: DeviceContext;
  /** The operating system. */
  readonly os: OsContext;
  /** The browser. */
  readonly browser: BrowserContext;
  /** The display. */
  readonly screen: ScreenContext;
  /** The page the event was created on. */
  readonly page: PageContext;
  /** The browser's preferred language, `navigator.language`, such as `tr-TR`. */
  readonly locale?: string;
  /** The time zone, such as `Europe/Istanbul`. */
  readonly timezone?: string;
  /** The session the event belongs to; absent when there is none, such as in a hidden tab. */
  readonly session?: SessionContext;
  /** This SDK; always present. */
  readonly library: LibraryContext;
}

/** The application that sent the event, from `context.app` in the configuration (Web Context 3). */
export interface AppContext {
  /** Such as `Shop`. */
  readonly name?: string;
  /** Such as your release number. */
  readonly version?: string;
  /** A stable identifier of the application, such as `com.example.shop`. */
  readonly namespace?: string;
}

/** The device (Web Context 1). */
export interface DeviceContext {
  /**
   * `phone`, `tablet` or `desktop`, read from the browser's user agent: best effort, and absent when
   * nothing tells. Other values may be added in minor versions.
   */
  readonly type?: string;
}

/** The operating system (Web Context 1). Its version is never sent: browsers no longer tell it reliably. */
export interface OsContext {
  /** Such as `Android`, `iOS`, `macOS` or `Windows`. */
  readonly name?: string;
}

/** The browser (Web Context 1). */
export interface BrowserContext {
  /** Such as `Chrome`, `Safari` or `Firefox`. */
  readonly name?: string;
  /** The major version only, such as `141`. */
  readonly version?: string;
}

/** The display (Web Context 3). */
export interface ScreenContext {
  /** In CSS pixels, the short side, so that it never implies the orientation. */
  readonly width?: number;
  /** In CSS pixels, the long side. */
  readonly height?: number;
  /**
   * `devicePixelRatio`, read once per page load at its first event: CSS pixels to device pixels,
   * which desktop page zoom changes; not a physical density.
   */
  readonly density?: number;
}

/** The page the event was created on (Web Context 2). */
export interface PageContext {
  /**
   * The origin and path, such as `https://shop.example.com/orders/:id`: ids in the path are masked
   * as `:id`, and the query and fragment are never sent.
   */
  readonly url?: string;
  /** The page the visitor came from, under the same rule as {@link PageContext.url}. */
  readonly referrer?: string;
  /** `innerWidth`, in CSS pixels. */
  readonly viewportWidth?: number;
  /** `innerHeight`, in CSS pixels. */
  readonly viewportHeight?: number;
  /** Only the query parameters named in `context.page.queryParams`; absent when none is present. */
  readonly query?: Readonly<Record<string, string>>;
  /** `document.title`, only with `context.page.title: true`. */
  readonly title?: string;
}

/** The session an event belongs to (Session 2). */
export interface SessionContext {
  /** A UUIDv7. */
  readonly id: string;
  /** When the session started, in epoch milliseconds. */
  readonly startedAt: number;
}

/** The SDK that sent the event; always present. */
export interface LibraryContext {
  /** `rubicon-web`. */
  readonly name: string;
  /** The SDK version, such as `0.1.0`. */
  readonly version: string;
}
