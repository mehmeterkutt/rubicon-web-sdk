import { maskPathIds, replaceLoneSurrogates } from 'rubicon-analytics-core';
import type {
  CallTimeContextRequest,
  CallTimeContextValues,
  ContextField,
  ContextProvider,
  DisabledContextFields,
  StaticContextValues,
} from 'rubicon-analytics-core';
import { queryValues } from './page-query';
import { browserOf, deviceTypeOf, osNameOf } from './user-agent';
import type { ClientHints } from './user-agent';

// The browser's `ContextProvider` (Web Context 1 to 4), the counterpart of the Android
// `AndroidContextProvider`. Nothing is read when it is made: the pipeline asks for the static values
// once, at the first event, and for the call-time values inside every public call (Web Context 4);
// there are no listeners. A disabled field is never read (Context 6, Web Context 5), and a value the
// browser does not give, or whose read throws, is left out (Context 3), as Android's `read` does.

/** Makes the provider; it reads nothing until the pipeline asks (Web Context 4). */
export function createBrowserContext(): ContextProvider {
  return { staticValues, callTimeValues };
}

function staticValues(disabled: DisabledContextFields): StaticContextValues {
  const on = (field: ContextField) => !disabled.has(field);
  // Read once for the fields that need them, and only if one does.
  const userAgent = once(() => text(navigator.userAgent));
  const hints = once(readClientHints);
  const touchPoints = once(readMaxTouchPoints);
  const shortSide = once(() => screenSides()[0]);
  const browser = on('browser.name') || on('browser.version') ? read(() => browserOf(userAgent(), hints())) : undefined;
  const sides = on('screen.width') || on('screen.height') ? read(screenSides) : undefined;
  return {
    osName: on('os.name') ? read(() => osNameOf(userAgent(), hints(), touchPoints)) : undefined,
    browserName: on('browser.name') ? browser?.name : undefined,
    browserVersion: on('browser.version') ? browser?.version : undefined,
    deviceType: on('device.type')
      ? read(() =>
          deviceTypeOf({
            userAgent: userAgent(),
            hints: hints(),
            maxTouchPoints: touchPoints,
            screenShortSide: shortSide,
          }),
        )
      : undefined,
    // The short side first, so the value never implies the orientation (Web Context 3).
    screenWidth: on('screen.width') ? positive(sides?.[0]) : undefined,
    screenHeight: on('screen.height') ? positive(sides?.[1]) : undefined,
    screenDensity: on('screen.density') ? read(() => positive(window.devicePixelRatio)) : undefined,
    // Once per page load: `document.referrer` does not change with `pushState` (Web Context 4).
    pageReferrer: on('page.referrer') ? read(() => cleanUrl(document.referrer)) : undefined,
  };
}

function callTimeValues(request: CallTimeContextRequest): CallTimeContextValues {
  const on = (field: ContextField) => !request.disabled.has(field);
  return {
    pageUrl: on('page.url') ? read(() => originAndPath(location.origin, location.pathname)) : undefined,
    viewportWidth: on('page.viewport_width') ? read(() => size(window.innerWidth)) : undefined,
    viewportHeight: on('page.viewport_height') ? read(() => size(window.innerHeight)) : undefined,
    pageQuery:
      on('page.query') && request.queryParams.length > 0
        ? read(() => queryValues(location.search, request.queryParams))
        : undefined,
    // Off by default; no masking (Web Context 2). Lone surrogates become U+FFFD (Web Serialization 1).
    pageTitle: request.title ? read(() => nonEmpty(replaceLoneSurrogates(text(document.title)))) : undefined,
    locale: on('locale') ? read(() => nonEmpty(navigator.language)) : undefined,
    timezone: on('timezone') ? read(readTimezone) : undefined,
  };
}

/**
 * `page.url` and `page.referrer` (Web Context 2): the origin and the path with ids masked (Privacy
 * 5c), never the query or the fragment; nothing for an opaque origin (`null`, such as `about:blank`
 * or a `file:` page), which has no origin to send.
 */
export function originAndPath(origin: string, path: string): string | undefined {
  if (origin === '' || origin === 'null') return undefined;
  return origin + maskPathIds(path);
}

/** A full URL, such as `document.referrer`, under the rule of {@link originAndPath}; empty gives nothing. */
export function cleanUrl(text: string): string | undefined {
  if (text === '') return undefined;
  const url = new URL(text);
  return originAndPath(url.origin, url.pathname);
}

// `navigator.userAgentData` with the low-entropy values only, when the browser has it (Chrome 90 and
// Edge; neither Firefox nor Safari), checked field by field, never trusted.
function readClientHints(): ClientHints | undefined {
  const data: unknown = Reflect.get(navigator, 'userAgentData');
  if (typeof data !== 'object' || data === null) return undefined;
  const brands: unknown = Reflect.get(data, 'brands');
  const mobile: unknown = Reflect.get(data, 'mobile');
  const platform: unknown = Reflect.get(data, 'platform');
  const valid: { brand: string; version: string }[] = [];
  if (Array.isArray(brands)) {
    for (const entry of brands as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const brand: unknown = Reflect.get(entry, 'brand');
      const version: unknown = Reflect.get(entry, 'version');
      if (typeof brand === 'string' && typeof version === 'string') valid.push({ brand, version });
    }
  }
  return {
    brands: valid,
    mobile: typeof mobile === 'boolean' ? mobile : undefined,
    platform: typeof platform === 'string' ? platform : undefined,
  };
}

// `maxTouchPoints` is Safari 13 and Firefox 59; without it no touch is known (0).
function readMaxTouchPoints(): number {
  try {
    const points: unknown = Reflect.get(navigator, 'maxTouchPoints');
    return typeof points === 'number' && points > 0 ? points : 0;
  } catch {
    return 0;
  }
}

// `screen.width` and `screen.height` in CSS pixels, short side first; 0 when unknown.
function screenSides(): readonly [number, number] {
  try {
    const width = count(screen.width);
    const height = count(screen.height);
    return width <= height ? [width, height] : [height, width];
  } catch {
    return [0, 0];
  }
}

// `Intl.DateTimeFormat().resolvedOptions().timeZone`; nothing without `Intl` or with an empty zone.
function readTimezone(): string | undefined {
  if (typeof Intl === 'undefined') return undefined;
  const zone: unknown = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === 'string' ? nonEmpty(zone) : undefined;
}

// A read that throws (a getter, a stubbed object, a missing API) gives nothing (Context 3).
function read<T>(value: () => T | undefined): T | undefined {
  try {
    return value();
  } catch {
    return undefined;
  }
}

// Each value read at most once per `staticValues` call, and only when a field asks for it.
function once<T>(value: () => T): () => T {
  let done = false;
  let result: T | undefined;
  return () => {
    if (!done) {
      result = value();
      done = true;
    }
    return result as T;
  };
}

// A stubbed or broken page may give anything where the DOM types promise a string or a number.
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && isFinite(value) && value > 0 ? value : undefined;
}

function size(value: unknown): number | undefined {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : undefined;
}
