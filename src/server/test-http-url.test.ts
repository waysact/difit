import { describe, expect, it } from 'vitest';

import { testHttpUrl } from './test-http-url.js';

describe('testHttpUrl', () => {
  it.each([
    ['IPv4 listener', '127.0.0.1', 'IPv4', 'http://127.0.0.1:9101'],
    ['IPv6 listener', '::1', 'IPv6', 'http://[::1]:9101'],
    ['IPv4 wildcard', '0.0.0.0', 'IPv4', 'http://127.0.0.1:9101'],
    ['IPv6 wildcard', '::', 'IPv6', 'http://[::1]:9101'],
    ['specific IPv4 listener', '127.0.0.2', 'IPv4', 'http://127.0.0.2:9101'],
    ['specific IPv6 listener', '2001:db8::1', 'IPv6', 'http://[2001:db8::1]:9101'],
  ])('uses the %s address without DNS resolution', (_name, address, family, expected) => {
    expect(testHttpUrl({ address: () => ({ address, family, port: 9101 }) })).toBe(expected);
  });

  it.each([null, '/tmp/difit-test.sock'])('rejects non-TCP address %s', (address) => {
    expect(() => testHttpUrl({ address: () => address })).toThrow(
      'Expected a listening TCP server',
    );
  });
});
