import type { Server } from 'node:http';

/** Returns an HTTP origin for the test server's actual TCP listener. */
export function testHttpUrl(server: Pick<Server, 'address'>): string {
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('Expected a listening TCP test server');
  }
  const host =
    bound.address === '0.0.0.0' ? '127.0.0.1' : bound.address === '::' ? '::1' : bound.address;
  return bound.family === 'IPv6'
    ? `http://[${host}]:${bound.port}`
    : `http://${host}:${bound.port}`;
}
