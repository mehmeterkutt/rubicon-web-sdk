import { describe, expect, it } from 'vitest';
import { isPathId, maskPathIds } from '../../src';

// The id masking of Privacy 5c (Web Context 2), with the Android vectors of
// `RubiconNetworkInterceptorTest` ("ids are digits, UUIDs or hexadecimal longer than 16 characters")
// copied verbatim.

describe('isPathId (the Android vectors)', () => {
  it('ids are digits, UUIDs or hexadecimal longer than 16 characters', () => {
    expect(isPathId('12345')).toBe(true);
    expect(isPathId('3f2a9c1e-0b1c-4d2e-8f3a-7b2d9c1e0b1c')).toBe(true);
    expect(isPathId('0123456789abcdef0')).toBe(true);
    expect(isPathId('0123456789abcdef')).toBe(false);
    expect(isPathId('search')).toBe(false);
    expect(isPathId('v1')).toBe(false);

    expect(maskPathIds('/files/3f2a9c1e-0b1c-4d2e-8f3a-7b2d9c1e0b1c/download/v1/products/search')).toBe(
      '/files/:id/download/v1/products/search',
    );
  });
});

describe('isPathId on the web', () => {
  it('takes a UUID and hexadecimal in either letter case', () => {
    expect(isPathId('3F2A9C1E-0B1C-4D2E-8F3A-7B2D9C1E0B1C')).toBe(true);
    expect(isPathId('0123456789ABCDEF0')).toBe(true);
  });

  it('a segment that only contains an id is not one', () => {
    expect(isPathId('order-12345')).toBe(false);
    expect(isPathId('12345.json')).toBe(false);
    expect(isPathId('3f2a9c1e-0b1c-4d2e-8f3a-7b2d9c1e0b1c-x')).toBe(false);
    expect(isPathId('0123456789abcdeg0')).toBe(false);
    expect(isPathId('')).toBe(false);
  });

  it('a single digit and 17 hex digits are ids, as the rules read', () => {
    expect(isPathId('0')).toBe(true);
    expect(isPathId('a'.repeat(17))).toBe(true);
    expect(isPathId('a'.repeat(16))).toBe(false);
  });

  it('percent-encoded digits are not digits: the encoded path is what is matched', () => {
    expect(isPathId('%31%32')).toBe(false);
  });
});

describe('maskPathIds', () => {
  it('masks every id segment and keeps the others', () => {
    expect(maskPathIds('/orders/8f1c0b1c2d3e4f5a6b/items')).toBe('/orders/:id/items');
    expect(maskPathIds('/users/42/orders/7')).toBe('/users/:id/orders/:id');
  });

  it('keeps the root, a trailing slash and empty segments', () => {
    expect(maskPathIds('/')).toBe('/');
    expect(maskPathIds('')).toBe('');
    expect(maskPathIds('/users/42/')).toBe('/users/:id/');
    expect(maskPathIds('/a//42')).toBe('/a//:id');
  });

  it('leaves a path without ids as it is', () => {
    expect(maskPathIds('/pages/blank.html')).toBe('/pages/blank.html');
  });
});
