// What the TypeScript blocks of README.md use besides rubicon-analytics (step 8.5): the build tools'
// environment values, the third-party libraries the guide shows next to the SDK, and the stand-in
// for a consent platform's API. Each is declared with only the members the guide uses, in the
// shape those libraries declare them, so the compiled blocks check the SDK's API and nothing else.

/** Vite's `import.meta.env` (vite/client). */
interface ImportMeta {
  readonly env: { readonly DEV: boolean };
}

/** The `process.env` that webpack and Next.js replace at build time. */
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

/** The guide's stand-in for the application's own logging. */
declare const myLogger: { log(level: string, message: string, error?: unknown): void };

/** The guide's stand-in for a consent platform: each vendor names its API differently. */
declare const cmp: {
  onConsentChange(listener: (choices: { readonly analytics: boolean }) => void): void;
};

declare module 'axios' {
  interface AxiosRequestConfig {
    adapter?: string;
    env?: { fetch?: typeof fetch };
  }
  interface AxiosStatic {
    create(config?: AxiosRequestConfig): unknown;
  }
  const axios: AxiosStatic;
  export default axios;
}

declare module '@sentry/browser' {
  interface Breadcrumb {
    category?: string;
    message?: string;
  }
  interface Exception {
    value?: string;
  }
  interface ErrorEvent {
    message?: string;
    exception?: { values?: Exception[] };
  }
  interface BrowserOptions {
    dsn?: string;
    beforeBreadcrumb?: (breadcrumb: Breadcrumb, hint?: unknown) => Breadcrumb | null;
    beforeSend?: (event: ErrorEvent, hint: unknown) => ErrorEvent | null;
  }
  export function init(options: BrowserOptions): void;
}
