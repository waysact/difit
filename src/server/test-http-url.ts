import type { Server } from 'node:http';
import { listenerApiUrl } from '../utils/listener-url.js';

/** Returns an HTTP origin for the test server's actual TCP listener. */
export function testHttpUrl(server: Pick<Server, 'address'>): string {
  return listenerApiUrl(server.address());
}
