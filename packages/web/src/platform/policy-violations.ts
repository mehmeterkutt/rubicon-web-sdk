import type { Unsubscribe } from 'rubicon-analytics-core';

// The Content Security Policy diagnosis of Web HTTP 3 (step 7.3): a `securitypolicyviolation` that
// shows the page's policy blocked a request to the SDK's host. The core logs `CSP_BLOCKED` once per
// page and never reclassifies the request, which stays `io`: the event arrives as a separate task and
// cannot be tied to one request.

/** The parts of a `SecurityPolicyViolationEvent` the diagnosis reads. */
export interface PolicyViolation {
  readonly disposition?: unknown;
  readonly effectiveDirective?: unknown;
  readonly blockedURI?: unknown;
}

interface Endpoint {
  readonly origin: string;
  readonly path: string;
}

/**
 * Listens to `securitypolicyviolation` on the document from the instance's start until the returned
 * function is called, and calls `onBlocked` for every violation of one of `endpoints` (see
 * {@link isEndpointViolation}). A listener that fails ignores that event.
 */
export function watchPolicyViolations(endpoints: readonly string[], onBlocked: () => void): Unsubscribe {
  const targets = endpointsOf(endpoints);
  const listener = (event: Event): void => {
    try {
      if (isEndpointViolation(event as PolicyViolation, targets)) onBlocked();
    } catch {
      // An event that cannot be read is not a diagnosis.
    }
  };
  document.addEventListener('securitypolicyviolation', listener);
  return () => {
    document.removeEventListener('securitypolicyviolation', listener);
  };
}

/** The origin and path of each endpoint URL; one that does not parse is left out. */
export function endpointsOf(urls: readonly string[]): Endpoint[] {
  const endpoints: Endpoint[] = [];
  for (const url of urls) {
    const parsed = parse(url);
    if (parsed !== undefined) endpoints.push({ origin: parsed.origin, path: parsed.pathname });
  }
  return endpoints;
}

/**
 * Web HTTP 3: `disposition` `"enforce"` (a Report-Only policy blocks nothing, and Safari before 15,
 * which has no `disposition`, is ignored), `effectiveDirective` `"connect-src"`, and a `blockedURI`
 * whose origin is an endpoint's and whose path, when the browser reports one, starts with that
 * endpoint's path. Some browsers report only the origin of a cross-origin URL.
 */
export function isEndpointViolation(violation: PolicyViolation, endpoints: readonly Endpoint[]): boolean {
  if (violation.disposition !== 'enforce' || violation.effectiveDirective !== 'connect-src') return false;
  const blocked = typeof violation.blockedURI === 'string' ? parse(violation.blockedURI) : undefined;
  if (blocked === undefined) return false;
  const withPath = blocked.pathname !== '/';
  return endpoints.some(
    (endpoint) => blocked.origin === endpoint.origin && (!withPath || blocked.pathname.indexOf(endpoint.path) === 0),
  );
}

function parse(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}
