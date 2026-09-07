import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runBoundedShutdown, SHUTDOWN_WATCHDOG_MS } from './shutdown.js';

describe('runBoundedShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits once with the given code after the cleanup finishes', async () => {
    const exit = vi.fn();
    const run = vi.fn(() => Promise.resolve());

    await runBoundedShutdown({ run, exit, exitCode: 0, timeoutMs: 50 });

    expect(run).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  /**
   * The failure this exists for: `claimShutdown()` has already disarmed the
   * CLI's SIGINT and `--timeout` exits, so a claimant whose cleanup never
   * settles leaves the run unkillable short of SIGKILL.
   */
  it('reports timeout and exits unsuccessfully when cleanup never settles', async () => {
    const exit = vi.fn();
    const reportError = vi.fn();

    void runBoundedShutdown({
      run: () => new Promise<void>(() => {}),
      exit,
      exitCode: 0,
      timeoutMs: 50,
      reportError,
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'Timed out while waiting for shutdown cleanup' }),
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('preserves a signal failure exit code when cleanup never settles', async () => {
    const exit = vi.fn();

    void runBoundedShutdown({
      run: () => new Promise<void>(() => {}),
      exit,
      exitCode: 130,
      failureExitCode: 130,
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
  });

  // Two exits would be as wrong as none: the watchdog must be cleared, not
  // merely outrun, once cleanup has finished.
  it('does not exit a second time once the watchdog delay has passed', async () => {
    const exit = vi.fn();
    let finish: (() => void) | undefined;

    const shutdown = runBoundedShutdown({
      run: () => new Promise<void>((resolve) => (finish = resolve)),
      exit,
      exitCode: 0,
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(30);
    finish?.();
    await shutdown;
    await vi.advanceTimersByTimeAsync(1000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('reports and exits unsuccessfully when cleanup rejects', async () => {
    const exit = vi.fn();
    const reportError = vi.fn();
    const error = new Error('watcher teardown failed');

    await expect(
      runBoundedShutdown({
        run: () => Promise.reject(error),
        exit,
        exitCode: 0,
        timeoutMs: 50,
        reportError,
      }),
    ).rejects.toBe(error);

    expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('defaults to SHUTDOWN_WATCHDOG_MS when no timeout is given', async () => {
    const exit = vi.fn();

    void runBoundedShutdown({ run: () => new Promise<void>(() => {}), exit, exitCode: 0 });

    await vi.advanceTimersByTimeAsync(SHUTDOWN_WATCHDOG_MS - 1);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  // unref()'d, so a pending watchdog can never be the reason a process that
  // would otherwise be done stays alive.
  it('unrefs the watchdog', async () => {
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((() => ({ unref })) as unknown as typeof setTimeout);

    try {
      await runBoundedShutdown({ run: () => Promise.resolve(), exit: vi.fn(), exitCode: 0 });
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(unref).toHaveBeenCalledTimes(1);
  });
});
