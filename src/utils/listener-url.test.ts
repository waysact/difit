import { describe, expect, it } from 'vitest';

import { listenerApiUrl } from './listener-url.js';

describe('listenerApiUrl', () => {
  it.each([
    ['::1', 'IPv6', 'http://[::1]:4966'],
    ['::', 'IPv6', 'http://[::1]:4966'],
    ['0.0.0.0', 'IPv4', 'http://127.0.0.1:4966'],
    ['127.0.0.2', 'IPv4', 'http://127.0.0.2:4966'],
  ])('connects to the actual listener address %s', (address, family, expected) => {
    expect(listenerApiUrl({ address, family, port: 4966 })).toBe(expected);
  });

  it.each([null, '/tmp/difit.sock'])('rejects a non-TCP listener %s', (address) => {
    expect(() => listenerApiUrl(address)).toThrow('TCP');
  });
});
