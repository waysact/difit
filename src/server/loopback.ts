import { BlockList, isIP, type AddressInfo } from 'node:net';

// A single set of loopback rules, checked with `BlockList#check`. An IPv4-mapped
// IPv6 address (`::ffff:127.0.0.1`) matches the 127.0.0.0/8 subnet below only when
// `check` is passed the family `'ipv6'` — with `'ipv4'` it returns false. We derive
// the family from `isIP`, which scores a mapped address as 6, so the mapped form is
// matched correctly. Deriving it wrong fails closed (over-blocks), never open.
const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet('127.0.0.1', 8, 'ipv4');
loopbackAddresses.addAddress('::1', 'ipv6');

/**
 * Classifies a bind address as loopback-only.
 *
 * `undefined` and `''` count as loopback: the CLI defaults `--host` to the empty
 * string (`src/cli/index.ts:113`) and `startServer` then binds `localhost`
 * (`src/server/server.ts:1053`). Anything reachable from another host — including
 * the wildcard addresses `0.0.0.0` and `::` — is not loopback.
 *
 * A value is validated as an IP address first (`node:net`'s `isIP`), then tested
 * against the loopback ranges (127.0.0.0/8, and `::1` in every equivalent form —
 * `0:0:0:0:0:0:0:1`, the IPv4-mapped `::ffff:127.0.0.1`, and so on — since
 * `BlockList` normalizes before comparing). A value that fails IP validation —
 * a malformed address such as `127.999.999.999`, a whitespace-only string, or a
 * hostname other than `localhost` — is never treated as loopback, including a
 * whitespace-only value such as `"   "`: only the *literal* empty string counts
 * as "unset", not a string that merely trims to one. An earlier, looser regex
 * let malformed addresses like that through, relying on Node's DNS resolver to
 * fail the bind rather than on this check.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  // The literal empty string (and undefined) means "unset". A whitespace-only
  // value is a real, deliberate value that merely trims to empty, so it must not
  // be folded into this case — it falls through to the IP validation below,
  // where it correctly fails as neither empty, localhost, nor a valid IP.
  if (host === undefined || host === '') {
    return true;
  }

  const normalized = host.trim().toLowerCase();

  if (normalized === 'localhost') {
    return true;
  }

  // Strip a single bracket pair from an IPv6 literal, e.g. "[::1]" -> "::1".
  const unbracketed =
    normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;

  const family = isIP(unbracketed);
  if (family === 0) {
    return false;
  }

  return loopbackAddresses.check(unbracketed, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Classifies the address a listening server actually bound to.
 *
 * `isLoopbackHost` classifies the raw `--host` string the operator typed, but
 * `net.isIP` rejects the abbreviated IPv4 forms `getaddrinfo` still accepts —
 * `127.1`, `127.0.1`, decimal or octal/hex forms, and so on — so a string
 * like `127.1` classifies as non-loopback there even though `listen` resolves
 * it to `127.0.0.1` and binds loopback-only. The same applies to a hostname
 * that happens to resolve to loopback. Pass this function `server.address()`
 * instead, once `listen` has succeeded: the OS has already resolved the bind
 * address by then, so it is always in canonical form and `isLoopbackHost`
 * classifies it correctly.
 *
 * `server.address()` returns `null` before listening or after the socket is
 * closed, and a plain string for a non-TCP listener (a Unix domain socket or
 * a Windows named pipe). Neither case can be classified, so both are treated
 * as *not* loopback — over-blocking is the safe direction, over-permitting
 * is not.
 */
export function isLoopbackAddress(address: AddressInfo | string | null): boolean {
  if (address === null || typeof address === 'string') {
    return false;
  }

  return isLoopbackHost(address.address);
}
