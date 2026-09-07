import { spawn, type ChildProcess } from 'child_process';

/**
 * Everything the launcher tells its caller about the review it just started. `url` is a
 * compatibility alias for `publicUrl`; `apiUrl` is the locally reachable origin an agent calls,
 * which is never the browser-facing proxy address.
 */
export interface BackgroundServerInfo {
  sessionId: string;
  port: number;
  pid: number;
  publicUrl: string;
  apiUrl: string;
  url: string;
  cursor: number;
}

export const BACKGROUND_CHILD_ENV = 'DIFIT_BACKGROUND_CHILD';

/**
 * Accept a child's readiness message only when it describes a review this launcher can hand on
 * whole. A child from an incompatible build must fail readiness visibly rather than leave the
 * caller holding a connection description with pieces missing.
 */
export function parseBackgroundHandshakeMessage(message: unknown): BackgroundServerInfo | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const parsed = message as Partial<BackgroundServerInfo>;
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const count = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

  if (
    !text(parsed.sessionId) ||
    !count(parsed.port) ||
    !count(parsed.pid) ||
    !text(parsed.publicUrl) ||
    !text(parsed.apiUrl) ||
    !text(parsed.url) ||
    !count(parsed.cursor)
  ) {
    return null;
  }

  return {
    sessionId: parsed.sessionId,
    port: parsed.port,
    pid: parsed.pid,
    publicUrl: parsed.publicUrl,
    apiUrl: parsed.apiUrl,
    url: parsed.url,
    cursor: parsed.cursor,
  };
}

/** Name what the child actually sent, so a version mismatch is diagnosable from the message. */
function describeHandshake(message: unknown): string {
  if (!message || typeof message !== 'object') return `${typeof message}`;
  const keys = Object.keys(message as Record<string, unknown>);
  return keys.length === 0 ? 'an object with no fields' : `an object with ${keys.join(', ')}`;
}

export function emitBackgroundHandshake(info: BackgroundServerInfo): void {
  process.send?.(info);
  process.disconnect?.();
}

export function releaseBackgroundChild(child: ChildProcess): void {
  if (child.connected) {
    child.disconnect();
  }
  child.stderr?.destroy();
  child.unref();
}

export function ignoreStdioErrorsForBackgroundDaemon(): void {
  process.stdout?.on?.('error', () => {});
  process.stderr?.on?.('error', () => {});
}

export async function startBackgroundProcess(spawnProcess: typeof spawn = spawn): Promise<void> {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('Unable to determine difit entrypoint for background process');
  }

  // Deliberately no --keep-alive: a background review is bounded by the server's own deadline and
  // cleanup, and inheriting keep-alive here is what used to make the child immortal.
  const childArgs = process.argv.slice(2).filter((arg) => arg !== '--background');
  if (!childArgs.includes('--no-open')) {
    childArgs.push('--no-open');
  }

  const child = spawnProcess(process.execPath, [scriptPath, ...childArgs], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      [BACKGROUND_CHILD_ENV]: '1',
    },
  });

  child.stderr?.setEncoding('utf8');

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = '';

    const cleanupListeners = (): void => {
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stderr?.removeListener('data', onStderr);
    };

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      cleanupListeners();
      callback();
    };

    const onStderr = (chunk: string): void => {
      stderr += chunk;
    };

    const onMessage = (message: unknown): void => {
      const handshake = parseBackgroundHandshakeMessage(message);
      if (!handshake) {
        // A child that answered but described the review in a shape this build cannot use is a
        // version mismatch, not a slow start. Say so now rather than waiting out the startup
        // timeout and reporting it as one.
        finish(() => {
          child.kill();
          releaseBackgroundChild(child);
          reject(
            new Error(
              `Background difit server sent an unusable readiness message: ${describeHandshake(message)}`,
            ),
          );
        });
        return;
      }

      finish(() => {
        console.log(JSON.stringify(handshake));
        releaseBackgroundChild(child);
        resolve();
      });
    };

    const onError = (error: Error): void => {
      finish(() => {
        releaseBackgroundChild(child);
        reject(error);
      });
    };

    const onClose = (code: number | null): void => {
      finish(() => {
        releaseBackgroundChild(child);
        const startupError = stderr.trim();
        reject(
          new Error(
            startupError || `Background difit server exited early (code ${code ?? 'unknown'})`,
          ),
        );
      });
    };

    const timeout = setTimeout(() => {
      finish(() => {
        child.kill();
        child.stderr?.destroy();
        reject(new Error('Timed out while starting background difit server'));
      });
    }, 10_000);

    child.stderr?.on('data', onStderr);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('close', onClose);
  });
}
