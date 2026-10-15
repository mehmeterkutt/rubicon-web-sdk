// gzip in the browser (Web HTTP 2): the browser's own `CompressionStream`, which costs no bundle size
// and runs off the main thread, when it exists and is not the broken one of WebKit 16.4 and 16.5.

/** The `CompressionStream` constructor, read from the page; absent below Chrome 80, Firefox 113, Safari 16.4. */
type CompressionStreamConstructor = new (format: 'gzip') => TransformStream<Uint8Array, Uint8Array>;

// Safari 16.4 and 16.5 write an invalid stream for larger inputs (WebKit bug 254021, fixed in 16.6;
// Mixpanel `utils.js:1770-1789`); the server would reject the batch. Safari is told as Mixpanel tells
// it: `Version/` and `Safari/` in a user agent of none of the browsers that copy both tokens.
const SAFARI_VERSION = /\bVersion\/(\d+)\.(\d+)\b.*\bSafari\//;
const NOT_SAFARI = /Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|Edge\/|OPR\/|SamsungBrowser|Android/;
// Every browser and web view on iOS and iPadOS 16.4 and 16.5 runs that WebKit, whatever its user
// agent calls it (plan section 15, step 7.3, the user's answer): `iPhone OS 16_4` on an iPhone,
// `CPU OS 16_4` on an iPad, `16_4_1` included.
const IOS_16_4_OR_16_5 = /\b(iPhone|CPU) OS 16_[45](?!\d)/;

/**
 * Whether the user agent's `CompressionStream` is the broken one of WebKit 16.4 and 16.5 (Web HTTP
 * 2): Safari 16.4 or 16.5, or any browser on iOS or iPadOS 16.4 or 16.5. The version is read from the
 * user agent and never sent; step 7.5's context parse keeps only the major version on the wire.
 */
export function hasBrokenCompression(userAgent: string): boolean {
  if (IOS_16_4_OR_16_5.test(userAgent)) return true;
  if (NOT_SAFARI.test(userAgent)) return false;
  const version = SAFARI_VERSION.exec(userAgent);
  return version !== null && version[1] === '16' && (version[2] === '4' || version[2] === '5');
}

/**
 * The page's `CompressionStream` when bodies may be gzipped (Web HTTP 2: present, and not Safari 16.4
 * or 16.5 or another browser on iOS 16.4 or 16.5), else `undefined`. Read when asked, never at import.
 */
export function usableCompressionStream(): CompressionStreamConstructor | undefined {
  try {
    const constructor: unknown = Reflect.get(window, 'CompressionStream');
    if (typeof constructor !== 'function') return undefined;
    if (hasBrokenCompression(navigator.userAgent)) return undefined;
    return constructor as CompressionStreamConstructor;
  } catch {
    return undefined;
  }
}

/**
 * `text` as UTF-8, gzipped by `compression`. The result is a Promise because the stream is: it is
 * used only outside the hiding and `pagehide` paths, which never compress (Web HTTP 2). A failure
 * rejects, and the caller sends the body uncompressed, which the wire format accepts.
 */
export function gzip(text: string, compression: CompressionStreamConstructor): Promise<ArrayBuffer> {
  // A throw inside the executor rejects the Promise, so nothing escapes to the caller.
  return new Promise<ArrayBuffer>((resolve) => {
    // `Response` encodes the text as UTF-8 and gives it as a stream wherever `CompressionStream` exists.
    const source = new Response(text).body;
    if (source === null) throw new TypeError('no body stream');
    resolve(new Response(source.pipeThrough(new compression('gzip'))).arrayBuffer());
  });
}
