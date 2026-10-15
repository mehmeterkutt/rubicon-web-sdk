# Content Security Policy

What a site's Content Security Policy must allow for the SDK (Web HTTP 6, with its Changed on note
of 2026-10-15). The SDK is one file: it loads no other script at run time, uses no `eval` or
`new Function`, adds no inline style or event handler, and contains no Trusted Types sink. So a
policy needs no `'unsafe-eval'`, no `'unsafe-inline'` and no `style-src` entry for it.

## `connect-src`

Every installation, npm included, sends `POST {host}/v1/batch` and `GET {host}/v1/config`. Allow the
origin of `host`:

```
connect-src 'self' https://analytics.example.com
```

Behind a first-party proxy on the page's own origin (`host: 'https://shop.example.com/rb'`),
`'self'` is enough. A request the policy blocks never leaves the browser: the SDK logs the error
`CSP_BLOCKED` once per page load (a `securitypolicyviolation` of an enforced `connect-src` for the
host's origin and endpoint path) and keeps the events for a later attempt; the failure itself is a
network failure retried with backoff, and the warning `UPLOAD_FAILED_OPAQUE` may follow. A
report-only policy blocks nothing and logs nothing.

## `script-src`

The npm package is part of your bundle and needs nothing here.

**Script build.** Allow the file's URL, or its origin. The file is served with
`Access-Control-Allow-Origin`, so its `integrity` attribute works:

```html
<script src="RUBICON_SCRIPT_URL" integrity="RUBICON_SCRIPT_INTEGRITY" crossorigin="anonymous"></script>
```

**Two-tag snippet.** Three tags reach `script-src`: the stub, your own inline `rubicon.init(...)`
call, and the script build loaded with `<script async src integrity crossorigin>` (README,
"Two-tag snippet").

- The stub's text is frozen and the same on every site (stub version 1), so it is allowed by its
  hash, which changes only with a new stub version:

  ```
  sha256-mywLhcK4TH7k1aho9iPYn0R3UrCoasuducthS/F4UEQ=
  ```

- Your `init` script is yours: allow it by its own hash, or move the call into a script file you
  already allow.
- A site that uses nonces writes its nonce on the tags in its own template instead; the snippet
  copies nothing.
- The library's URL as for the script build.

Example for the snippet, the backend on `analytics.example.com` and the file on `cdn.example.com`:

```
script-src 'self' https://cdn.example.com 'sha256-mywLhcK4TH7k1aho9iPYn0R3UrCoasuducthS/F4UEQ=' 'sha256-<hash of your init script>';
connect-src 'self' https://analytics.example.com
```

Each release publishes, with its version-pinned URL, the integrity hash of `rubicon.min.js` and the
stub's hash (`dist/snippet.json` of the build holds both). The stub's hash is checked by
`packages/web/test/unit/snippet.test.ts`, and the Playwright test
`packages/web/test/browser/snippet.spec.ts` runs the snippet under a policy of
`default-src 'none'` that allows only the stub's hash, the `init` script's hash, the library's
origin and the backend's origin.

## Trusted Types

A `<script>` tag written in the HTML is not a Trusted Types sink, and the SDK writes to none, so a
site that enforces Trusted Types needs nothing for the SDK.

## Mixed content

Not a policy setting, but it fails the same way: an `https` page cannot reach an `http` host. The
SDK then sends nothing and logs the error `CLEARTEXT_HOST`; `http` hosts work only from `http`
pages, and `localhost` and `127.0.0.1` from any page (Web HTTP 3, Web Configuration 4).
