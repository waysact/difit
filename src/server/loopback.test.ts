import { type AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { isLoopbackAddress, isLoopbackHost } from './loopback.js';

describe('isLoopbackHost', () => {
  it('treats an unset host as loopback, because the server defaults to localhost', () => {
    expect(isLoopbackHost(undefined)).toBe(true);
  });

  it('treats the empty string as loopback, because the CLI defaults --host to it', () => {
    expect(isLoopbackHost('')).toBe(true);
  });

  it.each([
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.0.0.53',
    '127.1.2.3',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
  ])('treats %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '::',
    '[::]',
    '192.168.1.10',
    '10.0.0.4',
    'difit.internal',
    'localhost.evil.com',
    '127.0.0.1.evil.com',
    '127.999.999.999',
    '127.000.000.001',
    '   ',
  ])('treats %s as non-loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it('ignores surrounding whitespace', () => {
    expect(isLoopbackHost('  127.0.0.1  ')).toBe(true);
    expect(isLoopbackHost('  0.0.0.0  ')).toBe(false);
  });
});

describe('isLoopbackAddress', () => {
  const addressInfo = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4'): AddressInfo => ({
    address,
    family,
    port: 4966,
  });

  it('treats null as not loopback, because the address cannot be determined', () => {
    // `server.address()` returns null before listening or after close. Failing
    // to determine the bound address must fail closed (not loopback), never
    // fail open.
    expect(isLoopbackAddress(null)).toBe(false);
  });

  it('treats a string address as not loopback, because it is a non-TCP listener', () => {
    // `server.address()` returns a plain string for a Unix domain socket or a
    // Windows named pipe -- neither is a host loopback classification applies
    // to, so this must also fail closed.
    expect(isLoopbackAddress('/tmp/difit.sock')).toBe(false);
  });

  it('treats the OS-resolved 127.0.0.1 as loopback, however the operator spelled --host', () => {
    // This is what `127.1`, `127.0.1`, and other abbreviated forms resolve to:
    // net.isIP rejects them, but getaddrinfo expands them, and `listen` binds
    // loopback-only. Classifying the resolved AddressInfo instead of the raw
    // string is what makes those forms classify correctly.
    expect(isLoopbackAddress(addressInfo('127.0.0.1'))).toBe(true);
  });

  it('treats the resolved ::1 as loopback', () => {
    expect(isLoopbackAddress(addressInfo('::1', 'IPv6'))).toBe(true);
  });

  it('treats the resolved 0.0.0.0 wildcard as not loopback', () => {
    expect(isLoopbackAddress(addressInfo('0.0.0.0'))).toBe(false);
  });

  it('treats the resolved :: wildcard as not loopback', () => {
    expect(isLoopbackAddress(addressInfo('::', 'IPv6'))).toBe(false);
  });

  it('treats a resolved routable address as not loopback', () => {
    expect(isLoopbackAddress(addressInfo('192.168.1.10'))).toBe(false);
  });
});
