import { describe, expect, it } from 'vitest';
import * as rubicon from '../../src';

describe('rubicon-analytics', () => {
  it('loads in jsdom', () => {
    expect(rubicon).toBeTypeOf('object');
    expect(window).toBeDefined();
  });
});
