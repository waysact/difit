/**
 * How long a claimed shutdown may spend on cleanup before the process is made
 * to exit anyway.
 */
export const SHUTDOWN_WATCHDOG_MS = 5000;

export interface BoundedShutdownOptions {
  /** The cleanup to run: watcher teardown, the final NDJSON write, and so on. */
  run: () => Promise<void>;
  /** Called with `exitCode` once `run` settles, or once the watchdog fires. */
  exit: (code: number) => void;
  /** The exit code the claiming path decided on: 0 idle, 2 --timeout, 130 SIGINT. */
  exitCode: number;
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
 * A forced exit uses the same code as an orderly one. The claim already
 * decided the outcome; the watchdog only bounds how long reporting it may
 * take. It can cut a still-pending NDJSON write short, which a consumer sees
 * as an unparsable final line: a visible failure, unlike a process that hangs
 * forever.
 *
 * The timer is `unref()`'d so it can never itself be the reason the process
 * stays alive, and is cleared as soon as cleanup settles so it cannot fire
 * afterwards. A rejecting `run` is rethrown rather than swallowed: it reaches
 * the caller as an unhandled rejection, which Node turns into an exit 1 --
 * the error code the `--format json` contract already reserves.
 */
export async function runBoundedShutdown(options: BoundedShutdownOptions): Promise<void> {
  const watchdog = setTimeout(
    () => options.exit(options.exitCode),
    options.timeoutMs ?? SHUTDOWN_WATCHDOG_MS,
  );
  watchdog.unref();

  try {
    await options.run();
  } finally {
    clearTimeout(watchdog);
  }

  options.exit(options.exitCode);
}
