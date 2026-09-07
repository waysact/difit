import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERRED_PORT, effectivePreferredPort } from './ports.js';

describe('effectivePreferredPort', () => {
  it('returns a valid preferredPort unchanged', () => {
    expect(effectivePreferredPort(5000)).toBe(5000);
  });

  it('falls back to DEFAULT_PREFERRED_PORT when preferredPort is undefined', () => {
    expect(effectivePreferredPort(undefined)).toBe(DEFAULT_PREFERRED_PORT);
  });

  it('falls back to DEFAULT_PREFERRED_PORT when preferredPort is NaN, matching startServer', () => {
    expect(effectivePreferredPort(NaN)).toBe(DEFAULT_PREFERRED_PORT);
  });
});
