import type { AddressInfo } from 'node:net';

/** Return the local HTTP origin for a bound TCP listener. */
export function listenerApiUrl(address: AddressInfo | string | null): string {
  if (address === null || typeof address === 'string')
    throw new Error('Expected a listening TCP server');
  const host =
    address.address === '0.0.0.0'
      ? '127.0.0.1'
      : address.address === '::'
        ? '::1'
        : address.address;
  return address.family === 'IPv6'
    ? `http://[${host}]:${address.port}`
    : `http://${host}:${address.port}`;
}
