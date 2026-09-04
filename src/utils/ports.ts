/** Port `startServer` tries first when `--port` is not given. */
export const DEFAULT_PREFERRED_PORT = 4966;

/**
 * The port `startServer` actually binds first: `preferredPort` falls back to
 * `DEFAULT_PREFERRED_PORT` the same way `startServer` itself does (server.ts
 * treats a falsy `preferredPort` -- `undefined` or `NaN` from a typo'd
 * `--port abc` -- as "not given"). Validators reasoning about the starting
 * port must agree with this or a bad `--port` can slip past them: `??` would
 * leave `NaN` in place, and `NaN < anything` is always `false`.
 */
export function effectivePreferredPort(preferredPort: number | undefined): number {
  return preferredPort || DEFAULT_PREFERRED_PORT;
}
