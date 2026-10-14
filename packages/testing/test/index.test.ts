import { describe, expect, it } from 'vitest';
import * as testing from '../src';

describe('rubicon-analytics-testing', () => {
  it('loads', () => {
    expect(testing).toBeTypeOf('object');
  });
});
