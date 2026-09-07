import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseBackgroundHandshakeMessage, type BackgroundServerInfo } from './background.js';
import { must } from '../test/must.js';

// This test talks to real servers over loopback. `vitest.setup.ts` has already replaced the global
// fetch with a stub by the time this module runs, so importing undici's is what gets a real one
// back; setting VITEST_SERVER_TEST here would be too late to matter.
const { fetch } = await import('undici');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'dist', 'cli', 'index.js');
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * The only test that runs the built `index.ts`. It exports nothing and parses at module scope, so
 * every unit test around this feature reaches the pieces it wires up directly, and none of them
 * notices if the wiring between them is deleted.
 *
 * What it asserts is the contract an agent actually depends on: one startup JSON document, a
 * launcher that exits while the server keeps running, and a review that can be driven to
 * completion and stopped entirely over REST.
 */

interface LaunchedReview {
  info: BackgroundServerInfo;
  stdout: string;
  stderr: string;
}

let running: LaunchedReview | null = null;

/** Ask the server to stop the way an agent would, and say whether it accepted. */
async function stopOverHttp(info: BackgroundServerInfo): Promise<boolean> {
  try {
    const response = await fetch(`${info.apiUrl}/api/session/stop`, {
      method: 'POST',
      headers: { 'X-Difit-Session': info.sessionId },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** True once the server process is gone. */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** True once nothing answers on the review's API any more. */
async function listenerClosed(info: BackgroundServerInfo): Promise<boolean> {
  try {
    await fetch(`${info.apiUrl}/api/session`, { headers: { 'X-Difit-Session': info.sessionId } });
    return false;
  } catch {
    return true;
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met before timeout');
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

/**
 * Run the launcher and return its validated startup metadata.
 *
 * The server is a detached grandchild, so its pid comes from the handshake rather than from the
 * launcher we spawned. Nothing here matches on process names: teardown only ever touches the pid
 * this function was told about.
 */
function launchReview(args: string[], stdinDiff?: string): Promise<LaunchedReview> {
  return new Promise<LaunchedReview>((settle, fail) => {
    const launcher: ChildProcess = spawn(process.execPath, [cliEntry, ...args, '--background'], {
      cwd: repoRoot,
      // Without a diff to feed, fd 0 must be /dev/null: a pipe there looks like stdin input.
      stdio: [stdinDiff === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    if (stdinDiff !== undefined) {
      launcher.stdin?.end(stdinDiff);
    }

    let stdout = '';
    let stderr = '';
    launcher.stdout?.setEncoding('utf8');
    launcher.stderr?.setEncoding('utf8');
    launcher.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    launcher.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    launcher.once('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (code !== 0 || lines.length !== 1) {
        fail(
          new Error(
            `launcher exited ${code ?? 'unknown'} with ${lines.length} stdout line(s)\n${stdout}\n${stderr}`,
          ),
        );
        return;
      }

      const handshakeLine = must(lines[0], 'the guard above accepted exactly one stdout line');
      let info: BackgroundServerInfo | null = null;
      try {
        info = parseBackgroundHandshakeMessage(JSON.parse(handshakeLine));
      } catch {
        info = null;
      }
      if (!info) {
        fail(new Error(`launcher printed an unusable handshake: ${handshakeLine}`));
        return;
      }

      const launched = { info, stdout, stderr };
      running = launched;
      settle(launched);
    });

    launcher.once('error', fail);
  });
}

const agent = (info: BackgroundServerInfo): Record<string, string> => ({
  'X-Difit-Session': info.sessionId,
  'Content-Type': 'application/json',
});

describe('difit --background, end to end', () => {
  beforeAll(() => {
    // Built here rather than trusted: `dist/` is a working-tree artefact that may be stale,
    // missing, or from another branch, and a stale binary would make this test assert the
    // contract of code that is no longer checked in.
    try {
      execFileSync(process.execPath, [tsc, '--project', 'tsconfig.cli.json'], {
        cwd: repoRoot,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      throw new Error(
        `tsc --project tsconfig.cli.json failed:\n${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      );
    }
  }, 300_000);

  afterEach(async () => {
    const launched = running;
    running = null;
    if (!launched) return;

    await stopOverHttp(launched.info);
    try {
      // A last resort, and only ever the server this test was handed the pid of. A stop that
      // worked has already left nothing here to kill.
      await waitUntil(() => Promise.resolve(processGone(launched.info.pid)), 5_000);
    } catch {
      if (!processGone(launched.info.pid)) process.kill(launched.info.pid, 'SIGKILL');
    }
  }, 30_000);

  it('returns a usable review, finishes at its deadline and stops over HTTP', async () => {
    const { info, stdout } = await launchReview([
      'HEAD',
      '--no-open',
      '--port',
      '9500',
      '--timeout',
      '1',
      '--idle-grace',
      '7',
      '--cleanup-grace',
      '10',
    ]);

    expect(JSON.parse(stdout.trim())).toEqual(info);
    expect(info.cursor).toBe(0);
    expect(info.url).toBe(info.publicUrl);

    // The launcher is gone, and the server it started is not.
    const session = await fetch(`${info.apiUrl}/api/session`, { headers: agent(info) });
    expect(session.status).toBe(200);
    // Every duration flag reached the server, not just the one whose effect we wait for.
    expect((await session.json()) as { session: { limits: unknown } }).toMatchObject({
      session: { limits: { idleGraceMs: 7_000, timeoutMs: 1_000, cleanupGraceMs: 10_000 } },
    });

    const response = await fetch(`${info.apiUrl}/api/session/result?wait=2`, {
      headers: agent(info),
    });
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      session: { sessionId: string; state: string; reason: string; cleanupAt: string | null };
      version: number;
      cursor: number;
    };
    expect(snapshot).toMatchObject({
      session: { sessionId: info.sessionId, state: 'finished', reason: 'review_timeout' },
    });
    // A finished background review advertises how long it stays reachable.
    expect(snapshot.session.cleanupAt).not.toBeNull();

    const wrongSession = await fetch(`${info.apiUrl}/api/session/stop`, {
      method: 'POST',
      headers: { 'X-Difit-Session': 'not-this-review' },
    });
    expect(wrongSession.status).toBe(409);

    expect(await stopOverHttp(info)).toBe(true);
    await waitUntil(() => listenerClosed(info));
    // A listener that closed while the process hung on a stray timer would look identical from
    // the outside, so check the process too.
    await waitUntil(() => Promise.resolve(processGone(info.pid)));
  }, 120_000);

  it('survives a busy client, closes user input at completion and still accepts agent work', async () => {
    const { info } = await launchReview([
      'HEAD',
      '--no-open',
      '--port',
      '9510',
      '--timeout',
      '15',
      '--cleanup-grace',
      '30',
      '--comment',
      JSON.stringify({
        type: 'thread',
        id: 'seeded',
        filePath: 'README.md',
        position: { side: 'new', line: 1 },
        body: 'Please look at this line',
      }),
    ]);

    const threadsResponse = await fetch(`${info.apiUrl}/api/threads`, { headers: agent(info) });
    const threads = (await threadsResponse.json()) as {
      threads: { id: string; messages: { id: string }[] }[];
      version: number;
      cursor: number;
    };
    expect(threads.threads.map((thread) => thread.id)).toEqual(['seeded']);

    // Seeded comments are in the journal from zero, so an agent starting at the cursor it was
    // handed sees them rather than skipping straight past.
    const replay = await fetch(`${info.apiUrl}/api/events?after=0`, { headers: agent(info) });
    const page = (await replay.json()) as {
      events: { cursor: number; type: string; actor: string }[];
      nextCursor: number;
      hasMore: boolean;
    };
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every((event) => event.actor === 'user')).toBe(true);

    // Nothing has happened since, so a bounded wait expires with an empty page on an ACTIVE
    // review. That is not completion.
    const started = Date.now();
    const quiet = await fetch(`${info.apiUrl}/api/events?after=${page.nextCursor}&wait=1`, {
      headers: agent(info),
    });
    expect(quiet.status).toBe(200);
    const quietPage = (await quiet.json()) as {
      events: unknown[];
      nextCursor: number;
      session: { state: string };
    };
    expect(quietPage.events).toEqual([]);
    expect(quietPage.nextCursor).toBe(page.nextCursor);
    expect(quietPage.session.state).toBe('active');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    const reply = await fetch(`${info.apiUrl}/api/threads/seeded/messages`, {
      method: 'POST',
      headers: agent(info),
      body: JSON.stringify({
        id: 'agent-1',
        body: 'Working on it',
        expectedVersion: threads.version,
      }),
    });
    expect(reply.status).toBe(200);
    const replied = (await reply.json()) as { version: number; replayed: boolean };
    expect(replied.replayed).toBe(false);

    // The same id, thread and body is the retry an agent makes after an ambiguous failure: it
    // must return the original rather than post a duplicate.
    const retry = await fetch(`${info.apiUrl}/api/threads/seeded/messages`, {
      method: 'POST',
      headers: agent(info),
      body: JSON.stringify({
        id: 'agent-1',
        body: 'Working on it',
        expectedVersion: threads.version,
      }),
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()) as { replayed: boolean }).toMatchObject({ replayed: true });

    // The person edits while the agent is busy: a bulk write that removes the agent's reply. The
    // journal has to record it as the user's doing, and the reply id must not be reusable after.
    const beforeUserEdit = (await (
      await fetch(`${info.apiUrl}/api/threads`, { headers: agent(info) })
    ).json()) as { threads: { messages: unknown[] }[]; version: number; cursor: number };
    const userEdit = await fetch(`${info.apiUrl}/api/comments`, {
      method: 'POST',
      headers: agent(info),
      body: JSON.stringify({
        threads: [
          {
            ...(beforeUserEdit.threads[0] as Record<string, unknown>),
            messages: [(beforeUserEdit.threads[0] as { messages: unknown[] }).messages[0]],
          },
        ],
        baseVersion: beforeUserEdit.version,
      }),
    });
    expect(userEdit.status).toBe(200);

    const userEvents = (await (
      await fetch(`${info.apiUrl}/api/events?after=${beforeUserEdit.cursor}`, {
        headers: agent(info),
      })
    ).json()) as { events: { type: string; actor: string }[] };
    expect(userEvents.events.some((e) => e.type === 'message.deleted' && e.actor === 'user')).toBe(
      true,
    );

    const afterDeletion = (await (
      await fetch(`${info.apiUrl}/api/threads`, { headers: agent(info) })
    ).json()) as { version: number };
    const resurrect = await fetch(`${info.apiUrl}/api/threads/seeded/messages`, {
      method: 'POST',
      headers: agent(info),
      body: JSON.stringify({
        id: 'agent-1',
        body: 'Working on it',
        expectedVersion: afterDeletion.version,
      }),
    });
    // Retrying a reply the user has since deleted must not quietly put it back.
    expect(resurrect.status).toBe(409);
    expect((await resurrect.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'reply_deleted' },
    });

    const finalResult = await fetch(`${info.apiUrl}/api/session/result?wait=25`, {
      headers: agent(info),
    });
    expect(finalResult.status).toBe(200);
    const finished = (await finalResult.json()) as { version: number; session: { state: string } };
    expect(finished.session.state).toBe('finished');

    // User input is closed; agent replies and non-destructive resolution are not.
    const userWrite = await fetch(`${info.apiUrl}/api/comments`, {
      method: 'POST',
      headers: agent(info),
      body: JSON.stringify({ threads: [], baseVersion: finished.version }),
    });
    expect(userWrite.status).toBe(409);
    expect((await userWrite.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'review_finished' },
    });

    const lateReply = await fetch(`${info.apiUrl}/api/threads/seeded/messages`, {
      method: 'POST',
      headers: agent(info),
      body: JSON.stringify({
        id: 'agent-2',
        body: 'Recorded after the review closed',
        expectedVersion: finished.version,
      }),
    });
    expect(lateReply.status).toBe(200);
    const afterLateReply = (await lateReply.json()) as { version: number };

    const resolve = await fetch(`${info.apiUrl}/api/threads/seeded`, {
      method: 'PATCH',
      headers: agent(info),
      body: JSON.stringify({ resolved: true, expectedVersion: afterLateReply.version }),
    });
    expect(resolve.status).toBe(200);
    const resolved = (await resolve.json()) as {
      threads: { resolved: boolean; messages: { id: string }[] }[];
    };
    // Resolution keeps every message, including the ones the agent added.
    expect(resolved.threads[0]).toMatchObject({ resolved: true });
    // 'agent-1' is absent because the person deleted it mid-review, not because resolving
    // dropped anything: the messages either side of it survived.
    expect(resolved.threads[0]?.messages.map((message) => message.id)).toEqual([
      'seeded',
      'agent-2',
    ]);

    // Drain the journal the way an event-mode agent must after completion: the review's own
    // finish event is there, from the system, and the page reports no more.
    const drained = (await (
      await fetch(`${info.apiUrl}/api/events?after=0`, { headers: agent(info) })
    ).json()) as {
      events: { cursor: number; type: string; actor: string }[];
      hasMore: boolean;
      session: { state: string; finishedCursor: number | null; cursor: number };
    };
    expect(drained.hasMore).toBe(false);
    const finishEvent = drained.events.find((event) => event.type === 'review.finished');
    expect(finishEvent).toMatchObject({ actor: 'system' });
    expect(drained.session.finishedCursor).toBe(finishEvent?.cursor);
    // Completion moved the journal on without touching the comment collection.
    expect(drained.session.cursor).toBeGreaterThan(finished.version);

    const stop = await fetch(`${info.apiUrl}/api/session/stop`, {
      method: 'POST',
      headers: agent(info),
    });
    expect(stop.status).toBe(200);
    // Stop returns the final state, so the last read is never lost to the shutdown.
    expect((await stop.json()) as { threads: unknown[] }).toMatchObject({
      session: { state: 'finished' },
      threads: resolved.threads,
    });
    await waitUntil(() => listenerClosed(info));
  }, 120_000);

  it('lets an abandoned review expire on its own instead of lingering', async () => {
    const { info } = await launchReview([
      'HEAD',
      '--no-open',
      '--port',
      '9520',
      '--timeout',
      '1',
      '--cleanup-grace',
      '1',
    ]);

    // Nobody ever connects and nobody ever stops it: the deadline finishes the review and the
    // cleanup grace ends the process, listener and all.
    await waitUntil(() => listenerClosed(info), 30_000);
    await waitUntil(
      () =>
        Promise.resolve(
          (() => {
            try {
              process.kill(info.pid, 0);
              return false;
            } catch {
              return true;
            }
          })(),
        ),
      30_000,
    );
  }, 120_000);

  it('reports a startup failure on stderr and leaves no server behind', async () => {
    await expect(
      launchReview(['definitely-not-a-real-ref', '--no-open', '--port', '9530']),
    ).rejects.toThrow();

    const orphan = await fetch('http://127.0.0.1:9530/api/session', {
      headers: { 'X-Difit-Session': 'anything' },
    }).catch(() => null);
    expect(orphan).toBeNull();
  }, 120_000);

  it('refuses to background a stdin review rather than reviewing something else', async () => {
    // The detached child has no stdin, so a piped diff cannot reach it. Silently falling back
    // to the default Git range would look like a working review of the wrong thing.
    const diff = [
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '',
    ].join('\n');
    await expect(launchReview(['--no-open', '--port', '9540'], diff)).rejects.toThrow(
      /--background cannot read a diff from stdin/,
    );

    const orphan = await fetch('http://127.0.0.1:9540/api/session', {
      headers: { 'X-Difit-Session': 'anything' },
    }).catch(() => null);
    expect(orphan).toBeNull();
  }, 120_000);
});
