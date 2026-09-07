/**
 * How long a claimed shutdown may spend on cleanup before the process is made
 * to exit anyway.
 */
export const SHUTDOWN_WATCHDOG_MS = 5000;

export interface BoundedShutdownOptions {
  /** The cleanup to run: watcher teardown, listener close, timer release, and so on. */
  run: () => Promise<void>;
  /** Called with `exitCode` once `run` settles, or once the watchdog fires. */
  exit: (code: number) => void;
  /** The exit code the claiming path decided on: 0 for an ordinary stop, 130/143 for a signal. */
  exitCode: number;
  /** The code used if cleanup rejects or exceeds its watchdog. Defaults to 1. */
  failureExitCode?: number;
  /** Receives rejected cleanup and watchdog timeout diagnostics before the failure exit. */
  reportError?: (error: unknown) => void;
  /** Overridable so a test does not have to wait out the real watchdog. */
  timeoutMs?: number;
}

/**
 * Runs the cleanup of an already-claimed shutdown, and makes sure the process
 * exits even when that cleanup never settles.
 *
 * `claimShutdown()` (see server.ts) deliberately lets only one of the idle,
 * `--timeout` and SIGINT paths proceed, so the path that claims is the only
 * exit the process has left: the other two return immediately from then on.
 * That makes a claimant which stalls -- a file watcher whose `stop()` never
 * resolves, say -- unkillable, because Ctrl-C now reaches a handler that
 * returns without exiting. Nothing short of SIGKILL ends the run.
 *
 * The watchdog below bounds that: cleanup gets `timeoutMs` to finish and the
 * exit happens either way. The claim stays exclusive, so the guarantee of one
 * `ReviewSnapshot` per run is untouched -- the loser paths still write
 * nothing, and this function never writes anything itself.
 *
 * A forced ordinary shutdown uses `failureExitCode` (normally 1), while a
 * signal claimant can preserve its signal exit code. The watchdog reports the
 * timeout before it exits, so a stalled cleanup is a visible failure instead of
 * a process that hangs forever.
 *
 * The timer is `unref()`'d so it can never itself be the reason the process
 * stays alive, and is cleared as soon as cleanup settles so it cannot fire
 * afterwards. A rejecting `run` reports the error, requests the failure exit,
 * and remains rejected for callers that need to observe cleanup failure.
 */
export async function runBoundedShutdown(options: BoundedShutdownOptions): Promise<void> {
  const failureExitCode = options.failureExitCode ?? 1;
  let forcedFailure = false;
  const fail = (error: unknown): void => {
    if (forcedFailure) return;
    forcedFailure = true;
    options.reportError?.(error);
    options.exit(failureExitCode);
  };
  const watchdog = setTimeout(
    () => fail(new Error('Timed out while waiting for shutdown cleanup')),
    options.timeoutMs ?? SHUTDOWN_WATCHDOG_MS,
  );
  watchdog.unref();

  try {
    await options.run();
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    clearTimeout(watchdog);
  }

  if (!forcedFailure) options.exit(options.exitCode);
}
