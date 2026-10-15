import type { DeviceType } from 'rubicon-analytics-core';

// The user agent parse of Web Context 1: `os.name`, `browser.name` with the major version and
// `device.type`, from the user agent string and the low-entropy User-Agent Client Hints
// (`navigator.userAgentData`: `brands`, `mobile`, `platform`; Chrome 90 and Edge), preferred where
// they exist. A small regex set, tested against a fixed list of reduced and unreduced strings
// (test/unit/user-agent.test.ts); no `getHighEntropyValues`, and nothing of the string is sent. Pure
// functions over the values read, so the browser provider reads only what an enabled field needs.

/** The low-entropy User-Agent Client Hints, as far as they could be read. */
export interface ClientHints {
  readonly brands: readonly { readonly brand: string; readonly version: string }[];
  readonly mobile?: boolean;
  readonly platform?: string;
}

/** What `device.type` is told from; the two heuristic inputs are read only when a rule needs them. */
export interface DeviceSignals {
  readonly userAgent: string;
  readonly hints: ClientHints | undefined;
  /** `navigator.maxTouchPoints`, 0 when the browser does not give it. */
  readonly maxTouchPoints: () => number;
  /** The short side of `screen` in CSS pixels, 0 when unknown. */
  readonly screenShortSide: () => number;
}

/**
 * The short screen side, in CSS pixels, from which an Android device whose user agent is a desktop's
 * ("request desktop site") counts as a tablet: Android's 600 dp, which CSS pixels only approximate
 * (zoom and OS scaling move them), so an auxiliary heuristic and never proof (Web Context 1).
 * Provisional, tuned on real devices in the demo (step 9.3).
 */
export const ANDROID_TABLET_MIN_SIDE = 600;

// Client Hints platforms, as Chromium reports them, to the names this SDK sends.
const HINT_PLATFORMS: Readonly<Record<string, string>> = {
  Android: 'Android',
  'Chrome OS': 'Chrome OS',
  'Chromium OS': 'Chrome OS',
  iOS: 'iOS',
  Linux: 'Linux',
  macOS: 'macOS',
  Windows: 'Windows',
};

// The user agent's platform token, first match wins: an iPhone's string also says `like Mac OS X`
// and an Android one `Linux`.
const UA_PLATFORMS: readonly (readonly [RegExp, string])[] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'Chrome OS'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/Linux/, 'Linux'],
];

// Client Hints brands this SDK names, in the order they are looked for; the others (`Chromium`, the
// "not a brand" entry, a brand not listed) leave the name to the user agent string.
const HINT_BRANDS: readonly (readonly [string, string])[] = [
  ['Microsoft Edge', 'Edge'],
  ['Opera', 'Opera'],
  ['Samsung Internet', 'Samsung Internet'],
  ['HeadlessChrome', 'HeadlessChrome'],
  ['Google Chrome', 'Chrome'],
];

// Browsers by their own token, first match wins: the Chromium-based ones before `Chrome/`, which
// they all carry, and Safari last, since every WebKit and Chromium string says `Safari/`. Legacy Edge
// (`Edge/15`, inside the floor) says `Chrome/` too. On iOS every browser is WebKit with its own token.
const UA_BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/\b(?:OPR|OPiOS)\/(\d+)/, 'Opera'],
  [/\bSamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
  [/\bHeadlessChrome\/(\d+)/, 'HeadlessChrome'],
  [/\b(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
  [/\bVersion\/(\d+)\b.*\bSafari\//, 'Safari'],
];

/** `os.name`: the Client Hints platform when it names one, else the user agent's platform token. */
export function osNameOf(
  userAgent: string,
  hints: ClientHints | undefined,
  maxTouchPoints: () => number,
): string | undefined {
  const fromHints = hints?.platform === undefined ? undefined : HINT_PLATFORMS[hints.platform];
  if (fromHints !== undefined) return fromHints;
  for (const [pattern, name] of UA_PLATFORMS) {
    if (!pattern.test(userAgent)) continue;
    // An iPad in Safari's default desktop mode says it is a Mac (Web Context 1).
    return name === 'macOS' && isIPadAsMac(userAgent, maxTouchPoints) ? 'iOS' : name;
  }
  return undefined;
}

/** `browser.name` and the major `browser.version`: a named Client Hints brand first, else the string. */
export function browserOf(
  userAgent: string,
  hints: ClientHints | undefined,
): { readonly name?: string; readonly version?: string } {
  if (hints !== undefined) {
    for (const [brand, name] of HINT_BRANDS) {
      const entry = hints.brands.find((candidate) => candidate.brand === brand);
      if (entry === undefined) continue;
      const major = /^\d+/.exec(entry.version);
      return major === null ? { name } : { name, version: major[0] };
    }
  }
  for (const [pattern, name] of UA_BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match !== null) return { name, version: match[1] };
  }
  return {};
}

/**
 * `device.type`, best effort (Web Context 1): a phone when Client Hints or the string says mobile;
 * iPad and an Android string without `Mobile` are tablets; the two known desktop disguises are
 * recovered by heuristics (an Android platform in Client Hints with touch, by the short screen side;
 * a Mac string with more than one touch point, an iPad); a desktop platform is a desktop; otherwise
 * nothing is said.
 */
export function deviceTypeOf(signals: DeviceSignals): DeviceType | undefined {
  const { userAgent, hints } = signals;
  if (hints?.mobile === true) return 'phone';
  if (/iPad/.test(userAgent)) return 'tablet';
  if (/iPhone|iPod/.test(userAgent)) return 'phone';
  if (/Android/.test(userAgent)) return /Mobile/.test(userAgent) ? 'phone' : 'tablet';
  if (hints?.platform === 'Android' && signals.maxTouchPoints() > 0) {
    return signals.screenShortSide() >= ANDROID_TABLET_MIN_SIDE ? 'tablet' : 'phone';
  }
  if (isIPadAsMac(userAgent, signals.maxTouchPoints)) return 'tablet';
  if (/Windows|Macintosh|CrOS|Linux|X11/.test(userAgent)) return 'desktop';
  return undefined;
}

// A Mac's string on a device with more than one touch point is an iPad: no Mac has a touch screen.
function isIPadAsMac(userAgent: string, maxTouchPoints: () => number): boolean {
  return /Macintosh/.test(userAgent) && maxTouchPoints() > 1;
}
