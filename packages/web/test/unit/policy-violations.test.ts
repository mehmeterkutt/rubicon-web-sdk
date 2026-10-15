import { describe, expect, it } from 'vitest';
import { endpointsOf, isEndpointViolation, watchPolicyViolations } from '../../src/platform/policy-violations';
import type { PolicyViolation } from '../../src/platform/policy-violations';

// The Content Security Policy diagnosis of Web HTTP 3 (step 7.3): which `securitypolicyviolation`
// events name the SDK's host, and the listener on the document. jsdom has no
// `SecurityPolicyViolationEvent`, so the events are plain events carrying its three fields; the
// engines fire real ones in `test/browser/fetch-transport.spec.ts`.

const ENDPOINTS = endpointsOf(['https://api.example.com/rb/v1/batch', 'https://api.example.com/rb/v1/config']);

function violation(fields: PolicyViolation): PolicyViolation {
  return { disposition: 'enforce', effectiveDirective: 'connect-src', ...fields };
}

describe('a violation of the host (Web HTTP 3)', () => {
  it('is an enforced connect-src violation of an endpoint, by its full URL or its origin alone', () => {
    expect(isEndpointViolation(violation({ blockedURI: 'https://api.example.com/rb/v1/batch' }), ENDPOINTS)).toBe(true);
    expect(isEndpointViolation(violation({ blockedURI: 'https://api.example.com/rb/v1/config' }), ENDPOINTS)).toBe(
      true,
    );
    expect(isEndpointViolation(violation({ blockedURI: 'https://api.example.com/rb/v1/batch?x=1' }), ENDPOINTS)).toBe(
      true,
    );
    expect(isEndpointViolation(violation({ blockedURI: 'https://api.example.com' }), ENDPOINTS)).toBe(true);
    expect(isEndpointViolation(violation({ blockedURI: 'https://api.example.com/' }), ENDPOINTS)).toBe(true);
  });

  it('is not a Report-Only violation, one without disposition, another directive, origin or path', () => {
    const url = 'https://api.example.com/rb/v1/batch';
    expect(isEndpointViolation(violation({ disposition: 'report', blockedURI: url }), ENDPOINTS)).toBe(false);
    expect(isEndpointViolation({ effectiveDirective: 'connect-src', blockedURI: url }, ENDPOINTS)).toBe(false);
    expect(isEndpointViolation(violation({ effectiveDirective: 'img-src', blockedURI: url }), ENDPOINTS)).toBe(false);
    expect(isEndpointViolation(violation({ blockedURI: 'https://api.example.com:8443/rb/v1/batch' }), ENDPOINTS)).toBe(
      false,
    );
    expect(isEndpointViolation(violation({ blockedURI: 'http://api.example.com/rb/v1/batch' }), ENDPOINTS)).toBe(false);
    expect(isEndpointViolation(violation({ blockedURI: 'https://api.example.com/other' }), ENDPOINTS)).toBe(false);
    expect(isEndpointViolation(violation({ blockedURI: 'https://cdn.example.com/rb/v1/batch' }), ENDPOINTS)).toBe(
      false,
    );
    expect(isEndpointViolation(violation({ blockedURI: 'inline' }), ENDPOINTS)).toBe(false);
    expect(isEndpointViolation(violation({ blockedURI: undefined }), ENDPOINTS)).toBe(false);
  });

  it('leaves out an endpoint that does not parse', () => {
    expect(endpointsOf(['not a url', 'https://h.example/v1/batch'])).toEqual([
      { origin: 'https://h.example', path: '/v1/batch' },
    ]);
  });
});

describe('the listener on the document', () => {
  function dispatch(fields: PolicyViolation): void {
    const event = new Event('securitypolicyviolation');
    for (const [name, value] of Object.entries(fields)) Object.defineProperty(event, name, { value });
    document.dispatchEvent(event);
  }

  it('reports each violation of an endpoint until it is removed', () => {
    let blocked = 0;
    const stop = watchPolicyViolations(['https://api.example.com/v1/batch'], () => {
      blocked += 1;
    });

    dispatch(violation({ blockedURI: 'https://api.example.com/v1/batch' }));
    dispatch(violation({ blockedURI: 'https://elsewhere.example/v1/batch' }));
    expect(blocked).toBe(1);

    stop();
    dispatch(violation({ blockedURI: 'https://api.example.com/v1/batch' }));
    expect(blocked).toBe(1);
  });

  it('an event whose fields throw is ignored', () => {
    let blocked = 0;
    const stop = watchPolicyViolations(['https://api.example.com/v1/batch'], () => {
      blocked += 1;
    });
    const event = new Event('securitypolicyviolation');
    Object.defineProperty(event, 'disposition', {
      get: () => {
        throw new Error('unreadable');
      },
    });
    expect(() => document.dispatchEvent(event)).not.toThrow();
    expect(blocked).toBe(0);
    stop();
  });
});
