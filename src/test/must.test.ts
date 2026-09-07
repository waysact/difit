import { describe, expect, it } from 'vitest';

import { must } from './must.js';

describe('must', () => {
  it('returns a present value unchanged', () => {
    const values: number[] = [0];
    expect(must(values[0], 'the fixture has one entry')).toBe(0);
  });

  it('fails with the stated reason when the value is missing', () => {
    const values: number[] = [];
    expect(() => must(values[0], 'the fixture has one entry')).toThrow(
      'Expected a value: the fixture has one entry',
    );
    expect(() => must(null, 'a null lookup')).toThrow('Expected a value: a null lookup');
  });
});
