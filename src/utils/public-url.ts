/**
 * Resolves `--public-url` against the port actually bound.
 *
 * `{port}` is the only placeholder. It exists because the reverse proxy encodes the
 * port in the hostname, and the port is not known until the server binds — so a
 * literal URL would force `--strict-port` on every caller.
 */
export function resolvePublicUrl(
  template: string | undefined,
  port: number,
  fallback: string,
): string {
  if (!template) {
    return fallback;
  }

  return template.split('{port}').join(String(port));
}
