import { describe, expect, it } from 'vitest';
import { ANDROID_TABLET_MIN_SIDE, browserOf, deviceTypeOf, osNameOf } from '../../src/platform/user-agent';
import type { ClientHints } from '../../src/platform/user-agent';

// The user agent parse of Web Context 1 over a fixed list of user agent strings: reduced (Chromium
// since 110: the frozen platform token and `<major>.0.0.0`) and unreduced (Firefox, Safari, older
// Chromium, the floor browsers of Web Public API 6), with and without the low-entropy Client Hints,
// and the two tablet rules. The provider with a stubbed `navigator` is browser-context.test.ts.

interface Case {
  readonly ua: string;
  readonly os?: string;
  readonly browser?: string;
  readonly version?: string;
  readonly device?: string;
}

const REDUCED: Readonly<Record<string, Case>> = {
  'Chrome on Windows': {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    os: 'Windows',
    browser: 'Chrome',
    version: '141',
    device: 'desktop',
  },
  'Chrome on macOS': {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    os: 'macOS',
    browser: 'Chrome',
    version: '141',
    device: 'desktop',
  },
  'Chrome on Linux': {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    os: 'Linux',
    browser: 'Chrome',
    version: '141',
    device: 'desktop',
  },
  'Chrome on ChromeOS': {
    ua: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    os: 'Chrome OS',
    browser: 'Chrome',
    version: '141',
    device: 'desktop',
  },
  'Chrome on an Android phone': {
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    os: 'Android',
    browser: 'Chrome',
    version: '141',
    device: 'phone',
  },
  'Chrome on an Android tablet': {
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    os: 'Android',
    browser: 'Chrome',
    version: '141',
    device: 'tablet',
  },
  'an Android web view': {
    ua: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36',
    os: 'Android',
    browser: 'Chrome',
    version: '141',
    device: 'phone',
  },
  'Edge on Windows': {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    os: 'Windows',
    browser: 'Edge',
    version: '141',
    device: 'desktop',
  },
  'Edge on Android': {
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0',
    os: 'Android',
    browser: 'Edge',
    version: '141',
    device: 'phone',
  },
  'Opera on Windows': {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0',
    os: 'Windows',
    browser: 'Opera',
    version: '124',
    device: 'desktop',
  },
  'Samsung Internet': {
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    os: 'Android',
    browser: 'Samsung Internet',
    version: '28',
    device: 'phone',
  },
  'headless Chrome': {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36',
    os: 'Linux',
    browser: 'HeadlessChrome',
    version: '141',
    device: 'desktop',
  },
};

const UNREDUCED: Readonly<Record<string, Case>> = {
  'Firefox on Windows': {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
    os: 'Windows',
    browser: 'Firefox',
    version: '143',
    device: 'desktop',
  },
  'Firefox on macOS': {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0',
    os: 'macOS',
    browser: 'Firefox',
    version: '143',
    device: 'desktop',
  },
  'Firefox on Linux': {
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
    os: 'Linux',
    browser: 'Firefox',
    version: '143',
    device: 'desktop',
  },
  'Firefox on an Android phone': {
    ua: 'Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
    os: 'Android',
    browser: 'Firefox',
    version: '143',
    device: 'phone',
  },
  'Firefox on an Android tablet': {
    ua: 'Mozilla/5.0 (Android 15; Tablet; rv:143.0) Gecko/143.0 Firefox/143.0',
    os: 'Android',
    browser: 'Firefox',
    version: '143',
    device: 'tablet',
  },
  'Safari on macOS': {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    os: 'macOS',
    browser: 'Safari',
    version: '26',
    device: 'desktop',
  },
  'Safari on an iPhone': {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    os: 'iOS',
    browser: 'Safari',
    version: '18',
    device: 'phone',
  },
  'Safari on an iPad asking for the mobile site': {
    ua: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    os: 'iOS',
    browser: 'Safari',
    version: '18',
    device: 'tablet',
  },
  'Chrome on an iPhone': {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
    os: 'iOS',
    browser: 'Chrome',
    version: '141',
    device: 'phone',
  },
  'Firefox on an iPhone': {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
    os: 'iOS',
    browser: 'Firefox',
    version: '143',
    device: 'phone',
  },
  'Edge on an iPhone': {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/141.0.3537.71 Version/18.0 Mobile/15E148 Safari/604.1',
    os: 'iOS',
    browser: 'Edge',
    version: '141',
    device: 'phone',
  },
  'an in-app web view on an iPhone, which names no browser': {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    os: 'iOS',
    device: 'phone',
  },
  'Chrome 74 on Android, before the reduction': {
    ua: 'Mozilla/5.0 (Linux; Android 9; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.157 Mobile Safari/537.36',
    os: 'Android',
    browser: 'Chrome',
    version: '74',
    device: 'phone',
  },
  'Chrome 55, the floor': {
    ua: 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/55.0.2883.87 Safari/537.36',
    os: 'Windows',
    browser: 'Chrome',
    version: '55',
    device: 'desktop',
  },
  'Edge 15, the floor (EdgeHTML)': {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Safari/537.36 Edge/15.15063',
    os: 'Windows',
    browser: 'Edge',
    version: '15',
    device: 'desktop',
  },
  'Firefox 52, the floor': {
    ua: 'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:52.0) Gecko/20100101 Firefox/52.0',
    os: 'Windows',
    browser: 'Firefox',
    version: '52',
    device: 'desktop',
  },
  'Safari 10.1, the floor': {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_4) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.1 Safari/603.1.30',
    os: 'macOS',
    browser: 'Safari',
    version: '10',
    device: 'desktop',
  },
  'iOS 10.3 Safari, the floor': {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1',
    os: 'iOS',
    browser: 'Safari',
    version: '10',
    device: 'phone',
  },
  'something that is no browser': { ua: 'curl/8.4.0' },
  'an empty string': { ua: '' },
};

const noTouch = () => 0;

function parse(ua: string, hints?: ClientHints, touch = noTouch, shortSide = () => 0): Case {
  const browser = browserOf(ua, hints);
  const parsed = {
    ua,
    os: osNameOf(ua, hints, touch),
    browser: browser.name,
    version: browser.version,
    device: deviceTypeOf({ userAgent: ua, hints, maxTouchPoints: touch, screenShortSide: shortSide }),
  };
  return JSON.parse(JSON.stringify(parsed)) as Case;
}

describe('the user agent string alone', () => {
  for (const [name, expected] of Object.entries(REDUCED)) {
    it(`reduced: ${name}`, () => {
      expect(parse(expected.ua)).toEqual(expected);
    });
  }
  for (const [name, expected] of Object.entries(UNREDUCED)) {
    it(`unreduced: ${name}`, () => {
      expect(parse(expected.ua)).toEqual(expected);
    });
  }
});

const CHROME_WINDOWS = REDUCED['Chrome on Windows']?.ua ?? '';
const CHROME_LINUX = REDUCED['Chrome on Linux']?.ua ?? '';
const SAFARI_MAC = UNREDUCED['Safari on macOS']?.ua ?? '';
const GREASE = { brand: 'Not)A;Brand', version: '8' };

describe('the low-entropy Client Hints, preferred where they exist', () => {
  it('a named brand gives the browser and its major version', () => {
    const hints: ClientHints = {
      brands: [GREASE, { brand: 'Chromium', version: '141' }, { brand: 'Google Chrome', version: '141' }],
      mobile: false,
      platform: 'Windows',
    };
    expect(parse(CHROME_WINDOWS, hints)).toMatchObject({ os: 'Windows', browser: 'Chrome', version: '141' });
  });

  it('Edge, Opera, Samsung Internet and headless Chrome are told by their own brand', () => {
    const brand = (name: string): ClientHints => ({
      brands: [{ brand: 'Chromium', version: '140' }, { brand: name, version: '139.0.1' }, GREASE],
    });
    expect(browserOf(CHROME_WINDOWS, brand('Microsoft Edge'))).toEqual({ name: 'Edge', version: '139' });
    expect(browserOf(CHROME_WINDOWS, brand('Opera'))).toEqual({ name: 'Opera', version: '139' });
    expect(browserOf(CHROME_WINDOWS, brand('Samsung Internet'))).toEqual({ name: 'Samsung Internet', version: '139' });
    expect(browserOf(CHROME_WINDOWS, brand('HeadlessChrome'))).toEqual({ name: 'HeadlessChrome', version: '139' });
  });

  it('a brand this SDK does not name leaves the browser to the string', () => {
    const brave: ClientHints = {
      brands: [
        { brand: 'Brave', version: '141' },
        { brand: 'Chromium', version: '141' },
      ],
    };
    expect(browserOf(CHROME_WINDOWS, brave)).toEqual({ name: 'Chrome', version: '141' });
    expect(browserOf(CHROME_WINDOWS, { brands: [] })).toEqual({ name: 'Chrome', version: '141' });
  });

  it('a brand version without digits gives the name alone', () => {
    expect(browserOf('', { brands: [{ brand: 'Google Chrome', version: '' }] })).toEqual({ name: 'Chrome' });
  });

  it('the platform names the OS, also against the string', () => {
    expect(osNameOf(CHROME_LINUX, { brands: [], platform: 'Android' }, noTouch)).toBe('Android');
    expect(osNameOf(CHROME_LINUX, { brands: [], platform: 'Chromium OS' }, noTouch)).toBe('Chrome OS');
    expect(osNameOf(CHROME_LINUX, { brands: [], platform: 'Chrome OS' }, noTouch)).toBe('Chrome OS');
    expect(osNameOf(CHROME_LINUX, { brands: [], platform: 'macOS' }, noTouch)).toBe('macOS');
  });

  it('an unknown or empty platform leaves the OS to the string', () => {
    expect(osNameOf(CHROME_LINUX, { brands: [], platform: 'Unknown' }, noTouch)).toBe('Linux');
    expect(osNameOf(CHROME_LINUX, { brands: [], platform: '' }, noTouch)).toBe('Linux');
  });

  it('mobile makes a phone whatever the string says', () => {
    expect(parse(CHROME_LINUX, { brands: [], mobile: true }).device).toBe('phone');
  });
});

describe('the tablet rules (Web Context 1)', () => {
  // Chrome on an Android tablet in "request desktop site" mode: a desktop Linux string, the Android
  // platform in Client Hints, not mobile.
  const desktopMode: ClientHints = {
    brands: [{ brand: 'Google Chrome', version: '141' }],
    mobile: false,
    platform: 'Android',
  };

  it('Android in desktop mode with touch and a short side of 600 CSS pixels or more is a tablet', () => {
    expect(ANDROID_TABLET_MIN_SIDE).toBe(600);
    expect(
      parse(
        CHROME_LINUX,
        desktopMode,
        () => 5,
        () => 800,
      ),
    ).toMatchObject({ os: 'Android', device: 'tablet' });
    expect(
      parse(
        CHROME_LINUX,
        desktopMode,
        () => 5,
        () => 600,
      ).device,
    ).toBe('tablet');
  });

  it('Android in desktop mode with touch and a shorter side is a phone', () => {
    expect(
      parse(
        CHROME_LINUX,
        desktopMode,
        () => 5,
        () => 599,
      ).device,
    ).toBe('phone');
    expect(
      parse(
        CHROME_LINUX,
        desktopMode,
        () => 5,
        () => 412,
      ).device,
    ).toBe('phone');
  });

  it('Android in desktop mode without touch is not recovered', () => {
    expect(parse(CHROME_LINUX, desktopMode, noTouch, () => 800).device).toBe('desktop');
  });

  it('a Mac string with more than one touch point is an iPad running iOS', () => {
    expect(parse(SAFARI_MAC, undefined, () => 5)).toMatchObject({ os: 'iOS', browser: 'Safari', device: 'tablet' });
  });

  it('a Mac string with one touch point or none stays a Mac', () => {
    expect(parse(SAFARI_MAC, undefined, () => 1)).toMatchObject({ os: 'macOS', device: 'desktop' });
    expect(parse(SAFARI_MAC, undefined, noTouch)).toMatchObject({ os: 'macOS', device: 'desktop' });
  });

  it('the heuristic inputs are read only when a rule needs them', () => {
    let reads = 0;
    const counted = () => {
      reads += 1;
      return 5;
    };
    deviceTypeOf({
      userAgent: REDUCED['Chrome on an Android phone']?.ua ?? '',
      hints: undefined,
      maxTouchPoints: counted,
      screenShortSide: counted,
    });
    osNameOf(CHROME_WINDOWS, undefined, counted);
    expect(reads).toBe(0);
  });
});
