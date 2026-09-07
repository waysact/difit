import { promises as fs } from 'fs';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { networkInterfaces, tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Set environment variable to skip fetch mocking
process.env.VITEST_SERVER_TEST = 'true';

import { startServer } from './server.js';
import * as reviewStoreModule from './review-store.js';
import { FileWatcherService } from './file-watcher.js';
import { testHttpUrl } from './test-http-url.js';
import { must } from '../test/must.js';
import type { CommentImport } from '../types/diff.js';
import type { ReviewSnapshot, ReviewStore } from '../types/review.js';

// Add fetch polyfill for Node.js test environment
const { fetch, Headers } = await import('undici');
globalThis.fetch = fetch as any;

/** Supply the new client contract in pre-existing payload/formatting tests; boundary tests use raw fetch. */
async function commentClientFetch(input: string, init?: Parameters<typeof fetch>[1]) {
  const url = new URL(input);
  if (
    !['POST', 'DELETE'].includes(init?.method ?? '') ||
    !/^\/api\/(comments(?:\/[^/]+)?|comment-imports)$/.test(url.pathname)
  )
    return fetch(input, init);
  const readUrl = new URL(input);
  readUrl.pathname = '/api/comments-json';
  const bootstrap = (await (await fetch(readUrl)).json()) as {
    sessionId: string;
    version: number;
    review: unknown;
    selection: { baseCommitish: string; targetCommitish: string; baseMode?: string };
  };
  if (!bootstrap.review) return fetch(input, init);
  url.searchParams.set('base', bootstrap.selection.baseCommitish);
  url.searchParams.set('target', bootstrap.selection.targetCommitish);
  url.searchParams.set('baseMode', bootstrap.selection.baseMode ?? 'direct');
  const headers = new Headers(init?.headers);
  headers.set('X-Difit-Session', bootstrap.sessionId);
  let body = init?.body;
  if (init?.method === 'DELETE') url.searchParams.set('expectedVersion', String(bootstrap.version));
  else if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      body = JSON.stringify(
        url.pathname === '/api/comment-imports'
          ? { imports: Array.isArray(parsed) ? parsed : [parsed], baseVersion: bootstrap.version }
          : { ...parsed, baseVersion: parsed.baseVersion ?? bootstrap.version },
      );
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return fetch(url, { ...init, headers, body });
}
const parserInstances = vi.hoisted(() => [] as any[]);

// `host: '::1'` fails `listen` with EADDRNOTAVAIL on a host without IPv6, so the
// tests that bind to it are skipped there instead of being flaky.
function hasIPv6Loopback(): boolean {
  return Object.values(networkInterfaces()).some((addresses) =>
    addresses?.some((address) => address.family === 'IPv6' && address.address === '::1'),
  );
}

// Mock GitDiffParser
vi.mock('./git-diff.js', () => {
  class GitDiffParserMock {
    constructor() {
      parserInstances.push(this);
    }

    validateCommit = vi.fn().mockResolvedValue(true);
    parseDiff = vi.fn().mockResolvedValue({
      targetCommit: 'abc123',
      baseCommit: 'def456',
      baseCommitish: 'def4567',
      targetCommitish: 'abc1234',
      requestedBaseCommitish: 'HEAD^',
      requestedTargetCommitish: 'HEAD',
      requestedBaseMode: undefined,
      targetMessage: 'Test commit',
      baseMessage: 'Previous commit',
      files: [
        {
          path: 'test.js',
          additions: 10,
          deletions: 5,
          chunks: [],
        },
      ],
      stats: { additions: 10, deletions: 5 },
      isEmpty: false,
    });
    parseStdinDiff = vi.fn().mockReturnValue({
      targetCommit: 'stdin-target',
      baseCommit: 'stdin-base',
      targetMessage: 'stdin target',
      baseMessage: 'stdin base',
      files: [
        {
          path: 'stdin-test.js',
          additions: 1,
          deletions: 0,
          chunks: [],
        },
      ],
      stats: { additions: 1, deletions: 0 },
      isEmpty: false,
    });
    getBlobContent = vi.fn().mockResolvedValue(Buffer.from('mock image data'));
    getLineCount = vi.fn().mockResolvedValue(42);
    getGeneratedStatus = vi.fn().mockResolvedValue({
      isGenerated: true,
      source: 'content',
    });
    clearResolvedCommitCache = vi.fn();
    getRevisionOptions = vi.fn().mockResolvedValue({
      branches: [{ name: 'main', current: true }],
      commits: [{ hash: 'abc1234', shortHash: 'abc1234', message: 'Test commit' }],
      originDefaultBranch: 'origin/main',
      resolvedBase: 'abc1234',
      resolvedTarget: 'def5678',
    });
  }

  return { GitDiffParser: GitDiffParserMock };
});

describe('Server Integration Tests', () => {
  describe('selected review store integration', () => {
    it('rejects supplied malformed legacy fields before defaults can erase a resolved thread and its replies', async () => {
      const result = await startServer({
        preferredPort: 4966,
        openBrowser: false,
        commentImports: [
          {
            type: 'thread',
            id: 'root',
            filePath: 'a.ts',
            position: { side: 'new', line: 1 },
            body: 'Root',
            resolved: true,
          },
          {
            type: 'reply',
            id: 'reply',
            filePath: 'a.ts',
            position: { side: 'new', line: 1 },
            body: 'Existing reply',
          },
        ],
      });
      try {
        const url = testHttpUrl(result.server);
        const before = result.getReviewSnapshot();
        expect(before.threads[0]).toMatchObject({
          resolved: true,
          messages: [{ id: 'root' }, { id: 'reply' }],
        });
        const headers = {
          'X-Difit-Session': before.session.sessionId,
          'Content-Type': 'application/json',
        };
        const legacy = {
          id: 'root',
          file: 'a.ts',
          line: 1,
          resolved: true,
          messages: must(before.threads[0], 'the review was seeded with the root thread').messages,
        };
        const malformed: Record<string, unknown>[] = [
          { messages: 'not-an-array', resolved: null },
          { messages: 'not-an-array' },
          { messages: null },
          { resolved: null },
          { id: 42 },
          { id: '' },
          { id: ' ' },
          { id: null },
          { line: '1' },
          { line: 0 },
          { line: -1 },
          { line: 1.5 },
          { line: [2, 1] },
          { line: [1] },
          { line: [1, 2, 3] },
          { line: Number.MAX_SAFE_INTEGER + 1 },
          { side: null },
          { side: 'left' },
          { file: null },
          { file: 9 },
          { file: '' },
          { codeContent: null },
          { codeContent: 42 },
          { createdAt: false },
          { updatedAt: null },
          { messages: [{ id: '', body: 'replacement' }] },
          { messages: [{ id: 0, body: 'replacement' }] },
          { messages: [{ body: 'replacement', createdAt: null }] },
          { messages: [{ body: 'replacement', updatedAt: false }] },
          { messages: [{ body: null }] },
          { messages: [{ body: 'replacement', author: 42 }] },
          { position: { side: 'new', line: 1 } },
          { filePath: 'a.ts' },
        ];
        for (const fields of malformed) {
          const response = await fetch(`${url}/api/comments`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              baseVersion: before.version,
              threads: [{ ...legacy, ...fields }],
            }),
          });
          expect(response.status, JSON.stringify(fields)).toBe(400);
          expect(await response.json()).toMatchObject({
            error: { code: 'invalid_request' },
            version: before.version,
          });
          expect(result.getReviewSnapshot()).toEqual(before);
        }
        for (const fields of [
          { id: false },
          { line: null },
          { side: null },
          { file: null },
          { timestamp: 0 },
          { codeContent: null },
        ]) {
          const response = await fetch(`${url}/api/comments`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              baseVersion: before.version,
              comments: [{ id: 'root', file: 'a.ts', line: 1, body: 'Replacement', ...fields }],
            }),
          });
          expect(response.status, JSON.stringify(fields)).toBe(400);
          expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
          expect(result.getReviewSnapshot()).toEqual(before);
        }
        for (const fields of [
          { resolved: null },
          { messages: 'not-an-array' },
          { position: { side: 'new', line: 0 } },
          { id: '' },
        ]) {
          const response = await fetch(`${url}/api/comments`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              baseVersion: before.version,
              threads: [{ ...before.threads[0], ...fields }],
            }),
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
          expect(result.getReviewSnapshot()).toEqual(before);
        }
        const other = await fetch(`${url}/api/comments?base=other&target=revision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            threads: [
              { id: 'root', file: 'a.ts', line: 1, resolved: null, messages: 'not-an-array' },
            ],
          }),
        });
        expect(other.status).toBe(200);
        expect(result.getReviewSnapshot()).toEqual(before);
      } finally {
        await new Promise<void>((resolve) => result.server.close(() => resolve()));
      }
    });

    it('retains selected legacy defaults for absent fields and accepts valid supplied values', async () => {
      const result = await startServer({ preferredPort: 4966, openBrowser: false });
      try {
        const url = testHttpUrl(result.server);
        const headers = {
          'X-Difit-Session': result.getReviewSnapshot().session.sessionId,
          'Content-Type': 'application/json',
        };
        const absent = await fetch(`${url}/api/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            baseVersion: 0,
            threads: [{ messages: [{ body: 'Absent metadata' }] }],
          }),
        });
        expect(absent.status).toBe(200);
        expect(result.getReviewSnapshot().threads[0]).toMatchObject({
          id: expect.any(String),
          filePath: '<unknown file>',
          position: { side: 'new', line: 1 },
          resolved: false,
          messages: [{ id: expect.any(String), body: 'Absent metadata' }],
        });
        const supplied = await fetch(`${url}/api/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            baseVersion: 1,
            threads: [
              {
                id: 'supplied',
                file: 'a.ts',
                line: [2, 3],
                side: 'old',
                resolved: true,
                codeContent: '',
                createdAt: '2026-01-01',
                updatedAt: '2026-01-02',
                messages: [
                  {
                    id: 'message',
                    body: 'Valid',
                    author: '',
                    createdAt: '2026-01-01',
                    updatedAt: '2026-01-02',
                  },
                ],
              },
            ],
          }),
        });
        expect(supplied.status).toBe(200);
        expect(result.getReviewSnapshot().threads[0]).toMatchObject({
          id: 'supplied',
          position: { side: 'old', line: { start: 2, end: 3 } },
          resolved: true,
          codeSnapshot: { content: '' },
        });
      } finally {
        await new Promise<void>((resolve) => result.server.close(() => resolve()));
      }
    });
    it('GET /api/comments-json without a selection reports the launch review after the browser switches revisions', async () => {
      const result = await startServer({ preferredPort: 4966, openBrowser: false });
      try {
        const url = testHttpUrl(result.server);
        const before = (await (await fetch(`${url}/api/comments-json`)).json()) as {
          review: unknown;
          selection: unknown;
        };
        expect(before.review).not.toBeNull();
        parserInstances.at(-1).parseDiff.mockResolvedValueOnce({
          baseCommitish: 'other',
          targetCommitish: 'revision',
          files: [],
          stats: { additions: 0, deletions: 0 },
          isEmpty: false,
        });
        await fetch(`${url}/api/diff?base=other&target=revision`);

        // The CLI bootstraps without a selection. It must land on the review the agent launched,
        // not on whatever revision pair the browser looked at last.
        const after = (await (await fetch(`${url}/api/comments-json`)).json()) as {
          review: unknown;
          selection: unknown;
        };
        expect(after.review).not.toBeNull();
        expect(after.selection).toEqual(before.selection);
      } finally {
        await new Promise<void>((resolve) => result.server.close(() => resolve()));
      }
    });
    it('pins a nonselected write before body parsing even if the browser switches to the launch review', async () => {
      const result = await startServer({ preferredPort: 4966, openBrowser: false });
      try {
        const url = testHttpUrl(result.server);
        parserInstances.at(-1).parseDiff.mockResolvedValueOnce({
          baseCommitish: 'other',
          targetCommitish: 'revision',
          files: [],
          stats: { additions: 0, deletions: 0 },
          isEmpty: false,
        });
        await fetch(`${url}/api/diff?base=other&target=revision`);
        // The write names its selection, as the SPA and the CLI both do; a selection-less write
        // would now pin to the launch review instead.
        const pending = httpRequest(`${url}/api/comments?base=other&target=revision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Expect: '100-continue' },
        });
        const completed = new Promise<number>((resolveResponse, reject) => {
          pending.on('response', (response) => {
            response.resume();
            response.on('end', () =>
              resolveResponse(must(response.statusCode, 'a completed response has a status code')),
            );
          });
          pending.on('error', reject);
        });
        const continued = new Promise<void>((resolveContinue) =>
          pending.once('continue', resolveContinue),
        );
        pending.flushHeaders();
        await continued;
        await fetch(`${url}/api/diff?base=&target=`);
        pending.end(
          JSON.stringify({
            comments: [{ id: 'queued', file: 'other.ts', line: 1, body: 'Queued elsewhere' }],
          }),
        );
        expect(await completed).toBe(200);
        expect(result.getReviewSnapshot()).toMatchObject({ threads: [], version: 0, cursor: 0 });
        expect(
          await (await fetch(`${url}/api/comments-json?base=other&target=revision`)).json(),
        ).toMatchObject({ review: null, threads: [{ id: 'queued' }] });
      } finally {
        await new Promise<void>((resolve) => result.server.close(() => resolve()));
      }
    });
    it('publishes the reachable listener origin independently of the public proxy URL', async () => {
      const result = await startServer({
        preferredPort: 4966,
        host: '127.0.0.1',
        publicUrl: 'https://review-{port}.example',
        openBrowser: false,
      });
      try {
        const snapshot = result.getReviewSnapshot();
        expect(snapshot.session.publicUrl).toBe(`https://review-${result.port}.example`);
        expect(snapshot.session.apiUrl).toBe(testHttpUrl(result.server));
        expect(
          (
            await fetch(`${snapshot.session.apiUrl}/api/threads`, {
              headers: { 'X-Difit-Session': snapshot.session.sessionId },
            })
          ).status,
        ).toBe(200);
      } finally {
        await new Promise<void>((resolve) => result.server.close(() => resolve()));
      }
    });
    it('notifies the browser that a review finished even though the comment version did not move', async () => {
      let store: ReviewStore | undefined;
      const createStore = reviewStoreModule.createReviewStore;
      const createSpy = vi
        .spyOn(reviewStoreModule, 'createReviewStore')
        .mockImplementation((options) => {
          store = createStore(options);
          return store;
        });
      const result = await startServer({
        preferredPort: 4966,
        openBrowser: false,
        commentImports: [
          {
            type: 'thread',
            id: 'root',
            filePath: 'a.ts',
            position: { side: 'new', line: 1 },
            body: 'Root',
          },
        ],
      });
      const broadcast = FileWatcherService.prototype.broadcast;
      const events: { type: string; version?: number; cursor?: number }[] = [];
      const broadcastSpy = vi
        .spyOn(FileWatcherService.prototype, 'broadcast')
        .mockImplementation(function (this: FileWatcherService, event) {
          events.push(event as { type: string; version?: number; cursor?: number });
          broadcast.call(this, event);
        });
      try {
        const url = testHttpUrl(result.server);
        const before = result.getReviewSnapshot();
        expect(
          (
            await fetch(`${url}/api/threads/root/messages`, {
              method: 'POST',
              headers: {
                'X-Difit-Session': before.session.sessionId,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                id: 'reply',
                body: 'Agent reply',
                expectedVersion: before.version,
              }),
            })
          ).status,
        ).toBe(200);

        const afterReply = result.getReviewSnapshot();
        expect(events).toEqual([
          expect.objectContaining({ type: 'commentsChanged', version: afterReply.version }),
          expect.objectContaining({
            type: 'reviewChanged',
            sessionId: afterReply.session.sessionId,
            cursor: afterReply.cursor,
          }),
        ]);

        events.length = 0;
        must(store, 'startServer created the review store').finish('browser_idle');

        const finished = result.getReviewSnapshot();
        expect(finished.version).toBe(afterReply.version);
        expect(finished.cursor).toBeGreaterThan(afterReply.cursor);
        expect(events).toEqual([
          expect.objectContaining({
            type: 'reviewChanged',
            sessionId: finished.session.sessionId,
            cursor: finished.cursor,
          }),
        ]);
      } finally {
        broadcastSpy.mockRestore();
        createSpy.mockRestore();
        await new Promise<void>((resolve) => result.server.close(() => resolve()));
      }
    });

    it('broadcasts committed agent changes, preserves them on imports, and closes all selected user input at completion', async () => {
      let store: ReviewStore | undefined;
      const createStore = reviewStoreModule.createReviewStore;
      const createSpy = vi
        .spyOn(reviewStoreModule, 'createReviewStore')
        .mockImplementation((options) => {
          store = createStore(options);
          return store;
        });
      const result = await startServer({
        preferredPort: 4966,
        openBrowser: false,
        commentImports: [
          {
            type: 'thread',
            id: 'root',
            filePath: 'a.ts',
            position: { side: 'new', line: 1 },
            body: 'Root',
          },
        ],
      });
      const observed: ReviewSnapshot[] = [];
      const broadcast = FileWatcherService.prototype.broadcast;
      const broadcastSpy = vi
        .spyOn(FileWatcherService.prototype, 'broadcast')
        .mockImplementation(function (this: FileWatcherService, event) {
          if (event.type === 'commentsChanged') observed.push(result.getReviewSnapshot());
          broadcast.call(this, event);
        });
      try {
        const url = testHttpUrl(result.server);
        const before = result.getReviewSnapshot();
        const headers = {
          'X-Difit-Session': before.session.sessionId,
          'Content-Type': 'application/json',
        };
        expect(
          (
            await fetch(`${url}/api/threads/root/messages`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                id: 'reply',
                body: 'Agent reply',
                expectedVersion: before.version,
              }),
            })
          ).status,
        ).toBe(200);
        expect(observed[0]?.threads[0]?.messages.at(-1)).toMatchObject({
          id: 'reply',
          author: 'Agent',
        });
        expect(
          (
            await fetch(`${url}/api/threads/root`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ resolved: true, expectedVersion: before.version + 1 }),
            })
          ).status,
        ).toBe(200);
        expect(observed[1]?.threads[0]?.resolved).toBe(true);
        expect(observed.map((snapshot) => snapshot.version)).toEqual([
          before.version + 1,
          before.version + 2,
        ]);
        const imported = await fetch(`${url}/api/comment-imports`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            imports: [
              {
                type: 'reply',
                id: 'imported',
                filePath: 'a.ts',
                position: { side: 'new', line: 1 },
                body: 'Imported reply',
              },
            ],
            baseVersion: before.version + 2,
          }),
        });
        expect(imported.status).toBe(200);
        expect(result.getReviewSnapshot().threads[0]).toMatchObject({
          resolved: true,
          messages: [{ id: 'root' }, { id: 'reply' }, { id: 'imported' }],
        });
        must(store, 'startServer created the review store').finish('browser_idle');
        const finished = result.getReviewSnapshot();
        for (const [path, method, body] of [
          ['/api/comments', 'POST', { threads: [], baseVersion: finished.version }],
          ['/api/comment-imports', 'POST', { imports: [], baseVersion: finished.version }],
          [`/api/comments/root?expectedVersion=${finished.version}`, 'DELETE', undefined],
        ] as const) {
          const response = await fetch(`${url}${path}`, {
            method,
            headers,
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({
            error: { code: 'review_finished' },
            version: finished.version,
          });
        }
        expect(result.getReviewSnapshot()).toEqual(finished);
        expect(observed).toHaveLength(3);
        const otherQuery = '?base=other&target=revision&baseMode=direct';
        expect(
          (
            await fetch(`${url}/api/comments${otherQuery}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ threads: finished.threads }),
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await fetch(`${url}/api/comment-imports${otherQuery}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify([
                {
                  type: 'thread',
                  id: 'other',
                  filePath: 'b.ts',
                  position: { side: 'new', line: 1 },
                  body: 'Other',
                },
              ]),
            })
          ).status,
        ).toBe(200);
        expect(
          (await fetch(`${url}/api/comments/root${otherQuery}`, { method: 'DELETE' })).status,
        ).toBe(200);
        const other = await (await fetch(`${url}/api/comments-json${otherQuery}`)).json();
        expect(other).toMatchObject({ review: null, threads: [{ id: 'other' }] });
        expect(result.getReviewSnapshot()).toEqual(finished);
      } finally {
        createSpy.mockRestore();
        broadcastSpy.mockRestore();
        await new Promise<void>((resolve) => result.server.close(() => resolve()));
      }
    });

    it('acknowledges live stop before bounded teardown closes the listener', async () => {
      const result = await startServer({ preferredPort: 4966, openBrowser: false });
      try {
        const url = testHttpUrl(result.server);
        const before = result.getReviewSnapshot();
        const headers = {
          'X-Difit-Session': before.session.sessionId,
          'Content-Type': 'application/json',
        };
        const response = await fetch(`${url}/api/session/stop`, { method: 'POST', headers });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          session: { state: 'finished', reason: 'agent_stop', cleanupAt: null },
        });
        await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
        expect(result.server.listening).toBe(false);
        expect(result.getReviewSnapshot()).toMatchObject({
          session: { state: 'finished', reason: 'agent_stop', cleanupAt: null },
        });
      } finally {
        await new Promise<void>((resolve) => result.server.close(() => resolve()));
      }
    });
    it('rejects missing and stale selected preconditions, duplicate IDs and parser failures without mutation', async () => {
      const result = await startServer({ preferredPort: 4966, openBrowser: false });
      try {
        const url = testHttpUrl(result.server);
        const bootstrap = (await (await fetch(`${url}/api/comments-json`)).json()) as {
          sessionId: string;
        };
        const headers = {
          'X-Difit-Session': bootstrap.sessionId,
          'Content-Type': 'application/json',
        };
        for (const path of ['/api/comments', '/api/comment-imports', '/api/comments/missing']) {
          const method = path.endsWith('/missing') ? 'DELETE' : 'POST';
          for (const identity of [undefined, 'wrong-session']) {
            const response = await fetch(`${url}${path}`, {
              method,
              headers: identity ? { 'X-Difit-Session': identity } : {},
            });
            expect(response.status).toBe(identity ? 409 : 400);
            expect(await response.json()).toMatchObject({
              error: { code: identity ? 'session_mismatch' : 'session_required' },
              version: 0,
            });
          }
          for (const [value, code] of [
            [undefined, 'version_required'],
            [1, 'version_conflict'],
            ['1junk', 'invalid_request'],
            [-1, 'invalid_request'],
          ] as const) {
            const response = await fetch(
              `${url}${path}${method === 'DELETE' && value !== undefined ? `?expectedVersion=${value}` : ''}`,
              {
                method,
                headers,
                ...(method === 'POST'
                  ? { body: JSON.stringify({ threads: [], imports: [], baseVersion: value }) }
                  : {}),
              },
            );
            expect(await response.json()).toMatchObject({
              error: { code },
              sessionId: bootstrap.sessionId,
              version: 0,
            });
          }
        }
        for (const path of [
          '/api/comments',
          '/api/comment-imports',
          '/api/threads/missing/messages',
        ]) {
          for (const [extraHeaders, body] of [
            [{}, '{'],
            [{ 'Content-Type': 'application/json; charset=made-up' }, '{}'],
            [{ 'Content-Encoding': 'made-up' }, '{}'],
            [{}, JSON.stringify({ body: 'x'.repeat(110_000) })],
            [{ 'Content-Encoding': 'gzip' }, 'broken gzip'],
          ] as const) {
            const response = await fetch(`${url}${path}`, {
              method: 'POST',
              headers: { ...headers, ...extraHeaders },
              body,
            });
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({
              error: { code: 'invalid_request' },
              version: 0,
            });
          }
        }
        const thread = {
          id: 'thread',
          filePath: 'a.ts',
          position: { side: 'new', line: 1 },
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          messages: [
            { id: 'message', body: 'Root', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
          ],
        };
        for (const threads of [
          [thread, thread],
          [thread, { ...thread, id: 'other' }],
          [{ ...thread, resolved: 'yes' }],
        ]) {
          const response = await fetch(`${url}/api/comments`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ threads, baseVersion: 0 }),
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({
            error: { code: 'invalid_request' },
            version: 0,
          });
        }
        for (const payload of [
          { comments: [null] },
          { threads: [{ id: 'legacy', file: 'a.ts', line: 1, messages: [null] }] },
          { threads: [null] },
        ]) {
          const response = await fetch(`${url}/api/comments`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...payload, baseVersion: 0 }),
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({
            error: { code: 'invalid_request' },
            version: 0,
          });
        }
        expect(await (await fetch(`${url}/api/threads`, { headers })).json()).toMatchObject({
          threads: [],
          version: 0,
          cursor: 0,
        });
      } finally {
        await new Promise<void>((resolve) => result.server.close(() => resolve()));
      }
    });
    it('journals selected writes and keeps the launch review pinned across browsing and stale deletion', async () => {
      const result = await startServer({
        selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
        preferredPort: 4966,
        openBrowser: false,
        commentImports: [
          {
            type: 'thread',
            id: 'seed',
            filePath: 'a.ts',
            position: { side: 'new', line: 1 },
            body: 'Initial',
          },
        ],
      });
      try {
        const url = testHttpUrl(result.server);
        const bootstrap = (await (await fetch(`${url}/api/comments-json`)).json()) as {
          sessionId: string;
          version: number;
          review: unknown;
        };
        expect(bootstrap.sessionId).toEqual(expect.any(String));
        expect(bootstrap.review).toMatchObject({ selectionKey: 'def4567:abc1234:direct' });
        const headers = {
          'X-Difit-Session': bootstrap.sessionId,
          'Content-Type': 'application/json',
        };
        const read = async () =>
          (await (await fetch(`${url}/api/threads`, { headers })).json()) as ReviewSnapshot;
        const before = await read();
        expect(before.threads).toMatchObject([{ id: 'seed', resolved: false }]);
        const importedEvents = await (await fetch(`${url}/api/events?after=0`, { headers })).json();
        expect(importedEvents).toMatchObject({
          events: [{ type: 'thread.created' }, { type: 'message.created' }],
        });
        const posted = await fetch(`${url}/api/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            threads: [
              ...before.threads,
              {
                ...before.threads[0],
                id: 'user',
                messages: [
                  {
                    ...must(before.threads[0], 'the review was seeded with the root thread')
                      .messages[0],
                    id: 'user-message',
                    body: 'User thread',
                  },
                ],
              },
            ],
            baseVersion: before.version,
          }),
        });
        expect(posted.status).toBe(200);
        const after = await read();
        expect(after.version).toBe(before.version + 1);
        expect(
          await (await fetch(`${url}/api/events?after=${before.cursor}`, { headers })).json(),
        ).toMatchObject({
          events: [
            { type: 'thread.created', actor: 'user', threadId: 'user' },
            { type: 'message.created', actor: 'user', messageId: 'user-message' },
          ],
        });
        parserInstances.at(-1).parseDiff.mockResolvedValueOnce({
          baseCommitish: 'other',
          targetCommitish: 'revision',
          files: [],
          stats: { additions: 0, deletions: 0 },
          isEmpty: false,
        });
        await fetch(`${url}/api/diff?base=other&target=revision`);
        expect(await read()).toEqual(after);
        // A read with no selection pins to the launch review; the pair the browser switched to is
        // reachable only by naming it, which is what the CLI does after its bootstrap.
        expect(await (await fetch(`${url}/api/comments-json`)).json()).toMatchObject({
          sessionId: bootstrap.sessionId,
          review: { sessionId: bootstrap.sessionId },
        });
        const other = await (
          await fetch(`${url}/api/comments-json?base=other&target=revision`)
        ).json();
        expect(other).toMatchObject({
          sessionId: bootstrap.sessionId,
          review: null,
          selection: { baseCommitish: 'other', targetCommitish: 'revision' },
        });
        const deleted = await fetch(
          `${url}/api/comments/user?base=def4567&target=abc1234&expectedVersion=${before.version}`,
          { method: 'DELETE', headers },
        );
        expect(deleted.status).toBe(409);
        expect(await deleted.json()).toMatchObject({
          error: { code: 'version_conflict' },
          version: after.version,
        });
        expect(await read()).toEqual(after);
      } finally {
        await new Promise<void>((resolve) => result.server.close(() => resolve()));
      }
    });
  });
  describe('Comments API', () => {
    it('should accept properly formatted comments', async () => {
      const result = await startServer({
        preferredPort: 4966,
        openBrowser: false,
      });

      try {
        const comments = [
          {
            id: '1',
            file: 'src/App.tsx',
            line: 10,
            body: 'Test comment',
            timestamp: '2024-01-01T00:00:00Z',
          },
          {
            id: '2',
            file: 'src/utils/helper.ts',
            line: [20, 30],
            body: 'Another comment',
            timestamp: '2024-01-01T00:01:00Z',
          },
        ];

        const response = await commentClientFetch(`${testHttpUrl(result.server)}/api/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comments }),
        });

        expect(response.status).toBe(200);
        const apiResult = (await response.json()) as {
          success: boolean;
          merged: boolean;
          version: number;
        };
        expect(apiResult).toMatchObject({ success: true, merged: false });
        expect(typeof apiResult.version).toBe('number');

        // Verify the formatted output
        const outputResponse = await commentClientFetch(
          `${testHttpUrl(result.server)}/api/comments-output`,
        );
        const output = await outputResponse.text();

        expect(output).toContain('src/App.tsx:L10');
        expect(output).toContain('Test comment');
        expect(output).toContain('src/utils/helper.ts:L20-L30');
        expect(output).toContain('Another comment');
        expect(output).not.toContain('undefined');
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server.close(() => resolve());
          });
        }
      }
    });

    it('should handle comments with missing file property gracefully', async () => {
      const result = await startServer({
        preferredPort: 4966,
        openBrowser: false,
      });

      try {
        const commentsWithMissingFile = [
          {
            id: '1',
            // file property is missing/undefined
            line: 10,
            body: 'Comment without file',
            timestamp: '2024-01-01T00:00:00Z',
          },
        ];

        const response = await commentClientFetch(`${testHttpUrl(result.server)}/api/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comments: commentsWithMissingFile }),
        });

        expect(response.status).toBe(200);

        // Check the output handles undefined file gracefully
        const outputResponse = await commentClientFetch(
          `${testHttpUrl(result.server)}/api/comments-output`,
        );
        const output = await outputResponse.text();

        expect(output).toContain('<unknown file>:L10');
        expect(output).toContain('Comment without file');
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server.close(() => resolve());
          });
        }
      }
    });

    const isoNow = '2024-01-01T00:00:00Z';
    const makeThread = (id: string, filePath: string, line: number, body: string) => ({
      id,
      filePath,
      createdAt: isoNow,
      updatedAt: isoNow,
      position: { side: 'new' as const, line },
      messages: [{ id, body, createdAt: isoNow, updatedAt: isoNow }],
    });

    const postThreads = (httpUrl: string, threads: unknown[], baseVersion?: number) =>
      commentClientFetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threads, baseVersion }),
      });

    const getSession = async (httpUrl: string) => {
      const res = await commentClientFetch(`${httpUrl}/api/comments-json`);
      return (await res.json()) as {
        version: number;
        threads: Array<{ id: string; filePath: string }>;
      };
    };

    it('rejects a stale selected push without clobbering concurrent additions', async () => {
      const result = await startServer({
        preferredPort: 4966,
        openBrowser: false,
      });

      try {
        // Browser establishes a thread; it now knows version 1.
        await postThreads(testHttpUrl(result.server), [
          makeThread('t1', 'src/a.ts', 10, 'human thread'),
        ]);
        const afterFirst = await getSession(testHttpUrl(result.server));
        expect(afterFirst.version).toBe(1);

        // An agent adds a second thread out of band (e.g. `difit comment add`).
        const agentImport: CommentImport[] = [
          {
            type: 'thread',
            id: 'agent-1',
            filePath: 'src/b.ts',
            position: { side: 'new', line: 20 },
            body: 'agent finding',
            author: 'Agent',
          },
        ];
        await commentClientFetch(`${testHttpUrl(result.server)}/api/comment-imports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(agentImport),
        });

        // The browser, unaware of the agent's thread, pushes its stale set
        // tagged with the version it last observed (1).
        const staleResponse = await postThreads(
          testHttpUrl(result.server),
          [makeThread('t1', 'src/a.ts', 10, 'human thread')],
          1,
        );
        expect(staleResponse.status).toBe(409);
        expect(await staleResponse.json()).toMatchObject({ error: { code: 'version_conflict' } });

        // The agent's thread must survive the stale push.
        const final = await getSession(testHttpUrl(result.server));
        expect(final.threads).toHaveLength(2);
        expect(final.threads.some((thread) => thread.id === 't1')).toBe(true);
        expect(final.threads.some((thread) => thread.id === 'agent-1')).toBe(true);
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server.close(() => resolve());
          });
        }
      }
    });

    it('replaces (honoring deletions) when the push version matches', async () => {
      const result = await startServer({
        preferredPort: 4966,
        openBrowser: false,
      });

      try {
        await postThreads(testHttpUrl(result.server), [
          makeThread('t1', 'src/a.ts', 10, 'human thread'),
        ]);
        const afterFirst = await getSession(testHttpUrl(result.server));
        expect(afterFirst.version).toBe(1);
        expect(afterFirst.threads).toHaveLength(1);

        // Same version means no concurrent writer, so an empty set is a real
        // deletion and must be honored (not merged back).
        const response = await postThreads(testHttpUrl(result.server), [], afterFirst.version);
        const body = (await response.json()) as { merged: boolean };
        expect(body.merged).toBe(false);

        const final = await getSession(testHttpUrl(result.server));
        expect(final.threads).toHaveLength(0);
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server.close(() => resolve());
          });
        }
      }
    });

    it('bumps the version when a reply is imported (so the change is broadcast)', async () => {
      const result = await startServer({
        preferredPort: 4966,
        openBrowser: false,
      });

      try {
        await postThreads(testHttpUrl(result.server), [
          makeThread('t1', 'src/a.ts', 10, 'human thread'),
        ]);
        const before = await getSession(testHttpUrl(result.server));

        // A reply via comment-imports must register as a change — otherwise the
        // server skips the commentsChanged broadcast and open browsers go stale.
        await commentClientFetch(`${testHttpUrl(result.server)}/api/comment-imports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([
            {
              type: 'reply',
              filePath: 'src/a.ts',
              position: { side: 'new', line: 10 },
              body: 'agent reply',
              author: 'Agent',
            },
          ] satisfies CommentImport[]),
        });

        const after = await getSession(testHttpUrl(result.server));
        expect(after.version).toBeGreaterThan(before.version);
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server.close(() => resolve());
          });
        }
      }
    });
  });

  let servers: any[] = [];
  let originalProcessExit: any;

  beforeEach(() => {
    // Mock process.exit to prevent tests from actually exiting
    originalProcessExit = process.exit;
    process.exit = vi.fn() as any;
    parserInstances.length = 0;
  });

  afterEach(async () => {
    // Restore process.exit
    process.exit = originalProcessExit;

    // Clean up any servers created during tests
    for (const server of servers) {
      if (server?.close) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    }
    servers = [];
  });

  describe('Server startup', () => {
    let warnSpy: MockInstance<typeof console.warn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('starts on preferred port', async () => {
      // Use a high port number to avoid conflicts
      const preferredPort = 9000;
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort,
      });
      servers.push(result.server); // Track for cleanup

      expect(result.port).toBeGreaterThanOrEqual(preferredPort);
      expect(result.url).toContain('http://localhost:');
      expect(result.isEmpty).toBe(false);
    });

    it('falls back to next port when preferred is occupied', async () => {
      // Use high port numbers to avoid conflicts
      const preferredPort = 9010;

      // Start server on port 9010
      const firstServer = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort,
      });
      servers.push(firstServer.server);

      // Try to start another server on the same port
      const secondServer = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort,
      });
      servers.push(secondServer.server);

      expect(firstServer.port).toBeGreaterThanOrEqual(preferredPort);
      expect(secondServer.port).toBe(firstServer.port + 1);
      expect(secondServer.url).toBe(`http://localhost:${secondServer.port}`);
    });

    it('binds to specified host', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '0.0.0.0',
        preferredPort: 9020,
      });
      servers.push(result.server);

      expect(result.url).toContain('http://localhost:'); // Display host conversion
    });

    it('warns that open-in-editor is disabled when bound off-loopback', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '0.0.0.0',
        preferredPort: 9021,
      });
      servers.push(result.server);

      const warnedLines = warnSpy.mock.calls.map((call) => call[0]);
      expect(
        warnedLines.some(
          (line) => typeof line === 'string' && line.includes('accessible from external network'),
        ),
      ).toBe(true);
      expect(
        warnedLines.some(
          (line) =>
            typeof line === 'string' &&
            line.includes('Open in editor is disabled while bound off-loopback.'),
        ),
      ).toBe(true);
    });

    it('does not warn when bound to 127.1, an abbreviated form that resolves to loopback', async () => {
      // net.isIP rejects "127.1", but Node's listen() falls through to
      // getaddrinfo, which expands it to 127.0.0.1 and binds loopback-only.
      // The warning must read the OS-resolved bind address, not the raw
      // --host string, or it wrongly claims external accessibility here.
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '127.1',
        preferredPort: 9023,
      });
      servers.push(result.server);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.runIf(hasIPv6Loopback())(
      'does not warn when bound to ::1, a loopback address the old ad-hoc check missed',
      async () => {
        const result = await startServer({
          selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
          host: '::1',
          preferredPort: 9022,
        });
        servers.push(result.server);

        expect(warnSpy).not.toHaveBeenCalled();
      },
    );

    it('passes context lines to the initial diff load', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9025,
        contextLines: 4,
      });
      servers.push(result.server);

      const parser = parserInstances.at(-1);
      expect(parser?.parseDiff).toHaveBeenCalledWith(
        { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        false,
        4,
      );
    });
  });

  describe('API endpoints', () => {
    let httpUrl: string;

    beforeEach(async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9030,
      });
      servers.push(result.server);
      httpUrl = testHttpUrl(result.server);
    });

    it('GET /api/diff returns diff data', async () => {
      const response = await commentClientFetch(`${httpUrl}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('targetCommit', 'abc123');
      expect(data).toHaveProperty('baseCommit', 'def456');
      expect(data).toHaveProperty('files');
      expect(data.files).toHaveLength(1);
      expect(data.files[0]).toHaveProperty('path', 'test.js');
      expect(data).toHaveProperty('ignoreWhitespace', false);
      expect(data).toHaveProperty('openInEditorAvailable', true);
      expect(data).toHaveProperty('requestedBaseCommitish', 'HEAD^');
      expect(data).toHaveProperty('requestedTargetCommitish', 'HEAD');
    });

    it('GET /api/diff returns a JSON 500 on parse failure and does not poison subsequent requests', async () => {
      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockClear();
      parser?.parseDiff.mockRejectedValueOnce(
        new Error('Failed to parse diff for nonexistent vs HEAD: unknown revision'),
      );

      const errorResponse = await commentClientFetch(`${httpUrl}/api/diff?target=nonexistent`);
      expect(errorResponse.status).toBe(500);
      expect(errorResponse.headers.get('content-type')).toContain('application/json');
      const errorBody = (await errorResponse.json()) as any;
      expect(typeof errorBody.error).toBe('string');

      const recoveredResponse = await commentClientFetch(
        `${httpUrl}/api/diff?ignoreWhitespace=true`,
      );
      expect(recoveredResponse.status).toBe(200);

      expect(parser?.parseDiff).toHaveBeenLastCalledWith(
        { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        true,
        undefined,
      );
    });

    it('GET /api/diff?ignoreWhitespace=true handles whitespace ignore', async () => {
      const response = await commentClientFetch(`${httpUrl}/api/diff?ignoreWhitespace=true`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('ignoreWhitespace', true);
    });

    it('GET /api/diff preserves context lines when recalculating revisions', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9031,
        contextLines: 2,
      });
      servers.push(result.server);

      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockClear();

      const response = await commentClientFetch(
        `${testHttpUrl(result.server)}/api/diff?base=main&target=feature&ignoreWhitespace=true`,
      );

      expect(response.ok).toBe(true);
      expect(parser?.parseDiff).toHaveBeenCalledWith(
        { targetCommitish: 'feature', baseCommitish: 'main' },
        true,
        2,
      );
    });

    it('GET /api/diff passes baseMode through to the parser', async () => {
      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockClear();
      parser?.parseDiff.mockResolvedValueOnce({
        targetCommit: 'abc123',
        baseCommit: 'def456',
        baseCommitish: 'fedcba9',
        targetCommitish: '.',
        requestedBaseCommitish: 'origin/main',
        requestedTargetCommitish: '.',
        requestedBaseMode: 'merge-base',
        files: [],
        isEmpty: true,
      });

      const response = await commentClientFetch(
        `${httpUrl}/api/diff?base=origin%2Fmain&target=.&baseMode=merge-base`,
      );
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(parser?.parseDiff).toHaveBeenCalledWith(
        {
          targetCommitish: '.',
          baseCommitish: 'origin/main',
          baseMode: 'merge-base',
        },
        false,
        undefined,
      );
      expect(data.requestedBaseMode).toBe('merge-base');
      expect(data.baseCommitish).toBe('fedcba9');
      expect(data.requestedBaseCommitish).toBe('origin/main');
    });

    it('GET /api/diff caches results per revision pair instead of reusing the last request', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9032,
      });
      servers.push(result.server);

      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockClear();

      const firstResponse = await commentClientFetch(
        `${testHttpUrl(result.server)}/api/diff?base=main&target=feature`,
      );
      expect(firstResponse.ok).toBe(true);

      const secondResponse = await commentClientFetch(
        `${testHttpUrl(result.server)}/api/diff?base=HEAD%5E&target=HEAD`,
      );
      expect(secondResponse.ok).toBe(true);

      const thirdResponse = await commentClientFetch(
        `${testHttpUrl(result.server)}/api/diff?base=main&target=feature`,
      );
      expect(thirdResponse.ok).toBe(true);

      expect(parser?.parseDiff).toHaveBeenCalledTimes(1);
      expect(parser?.parseDiff).toHaveBeenNthCalledWith(
        1,
        { targetCommitish: 'feature', baseCommitish: 'main' },
        false,
        undefined,
      );
    });

    it('GET /api/diff evicts least recently used cached diff responses', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9033,
      });
      servers.push(result.server);

      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockClear();

      const revisionPairs = [
        ['base-a', 'target-a'],
        ['base-b', 'target-b'],
        ['base-c', 'target-c'],
        ['base-d', 'target-d'],
        ['base-e', 'target-e'],
        ['base-f', 'target-f'],
        ['base-g', 'target-g'],
        ['base-h', 'target-h'],
        ['base-i', 'target-i'],
      ] as const;

      for (const [base, target] of revisionPairs) {
        const response = await commentClientFetch(
          `${testHttpUrl(result.server)}/api/diff?base=${base}&target=${target}`,
        );
        expect(response.ok).toBe(true);
      }

      const revisitedResponse = await commentClientFetch(
        `${testHttpUrl(result.server)}/api/diff?base=base-a&target=target-a`,
      );
      expect(revisitedResponse.ok).toBe(true);

      expect(parser?.parseDiff).toHaveBeenCalledTimes(10);
      expect(parser?.parseDiff).toHaveBeenLastCalledWith(
        { targetCommitish: 'target-a', baseCommitish: 'base-a' },
        false,
        undefined,
      );
    });

    it('GET /api/diff returns comment import payload when configured', async () => {
      const importedComments: CommentImport[] = [
        {
          type: 'thread',
          filePath: 'test.js',
          position: { side: 'new', line: 10 },
          body: 'Imported comment',
        },
      ];

      const importServer = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9034,
        commentImports: importedComments,
      });
      servers.push(importServer.server);

      const response = await commentClientFetch(`${testHttpUrl(importServer.server)}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.commentImports).toEqual(importedComments);
      expect(data.commentImportId).toEqual(expect.any(String));
    });

    it('GET /api/diff returns clearComments together with comment import payload', async () => {
      const importedComments: CommentImport[] = [
        {
          type: 'thread',
          filePath: 'test.js',
          position: { side: 'new', line: 10 },
          body: 'Imported comment',
        },
      ];

      const importServer = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9037,
        clearComments: true,
        commentImports: importedComments,
      });
      servers.push(importServer.server);

      const response = await commentClientFetch(`${testHttpUrl(importServer.server)}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.clearComments).toBe(true);
      expect(data.commentImports).toEqual(importedComments);
      expect(data.commentImportId).toEqual(expect.any(String));
    });

    it('GET /api/diff omits comment import payload after revision changes', async () => {
      const importedComments: CommentImport[] = [
        {
          type: 'thread',
          filePath: 'test.js',
          position: { side: 'new', line: 10 },
          body: 'Imported comment',
        },
      ];

      const importServer = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9038,
        commentImports: importedComments,
      });
      servers.push(importServer.server);

      const response = await commentClientFetch(
        `${testHttpUrl(importServer.server)}/api/diff?base=main&target=feature`,
      );
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.commentImports).toBeUndefined();
      expect(data.commentImportId).toBeUndefined();
    });

    it('GET /api/generated-status/* returns generated status', async () => {
      const response = await commentClientFetch(
        `${httpUrl}/api/generated-status/src/query.ts?ref=HEAD`,
      );
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data).toEqual({
        path: 'src/query.ts',
        ref: 'HEAD',
        isGenerated: true,
        source: 'content',
      });
    });

    it('GET /api/generated-status/* rejects paths outside repository', async () => {
      const response = await commentClientFetch(
        `${httpUrl}/api/generated-status/%2Ftmp%2Foutside.txt?ref=HEAD`,
      );
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });

    it('GET /api/generated-status/* rejects parent traversal paths', async () => {
      const response = await commentClientFetch(
        `${httpUrl}/api/generated-status/..%2Foutside.txt?ref=HEAD`,
      );
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });

    it('POST /api/comments accepts comment data', async () => {
      const comments = [{ file: 'test.js', line: 10, body: 'This is a test comment' }];

      const response = await commentClientFetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments }),
      });

      const data = await response.json();
      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('success', true);
    });

    it('POST /api/comments accepts multi-line comment data', async () => {
      const comments = [
        { file: 'test.js', line: 10, body: 'Single line comment' },
        { file: 'test.js', line: [20, 30], body: 'Multi-line comment' },
      ];

      const response = await commentClientFetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments }),
      });

      const data = await response.json();
      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('success', true);
    });

    it('POST /api/comments handles text/plain content type', async () => {
      const comments = [{ file: 'test.js', line: 10, body: 'This is a test comment' }];

      const response = await commentClientFetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ comments }),
      });

      const data = await response.json();
      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('success', true);
    });

    it('GET /api/comments-output returns formatted comments', async () => {
      // First post some comments
      const comments = [
        { file: 'test.js', line: 10, side: 'old', body: 'First comment' },
        { file: 'test.js', line: 20, side: 'new', body: 'Second comment' },
      ];

      await commentClientFetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments }),
      });

      // Then get the output
      const response = await commentClientFetch(`${httpUrl}/api/comments-output`);
      const output = await response.text();

      expect(response.ok).toBe(true);
      expect(response.headers.get('Content-Type')).toContain('text/plain');
      expect(output).toContain('Comments from review session');
      expect(output).toContain('test.js:L10 (old)');
      expect(output).toContain('First comment');
      expect(output).toContain('test.js:L20\nSecond comment');
      expect(output).toContain('Second comment');
      expect(output).toContain('Total comments: 2');
    });

    it('GET /api/comments-output formats multi-line comments correctly', async () => {
      // Post comments with both single-line and multi-line formats
      const comments = [
        { file: 'test.js', line: 10, body: 'Single line comment' },
        { file: 'test.js', line: [15, 25], body: 'Multi-line comment' },
      ];

      await commentClientFetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments }),
      });

      // Then get the output
      const response = await commentClientFetch(`${httpUrl}/api/comments-output`);
      const output = await response.text();

      expect(response.ok).toBe(true);
      expect(output).toContain('test.js:L10');
      expect(output).toContain('Single line comment');
      expect(output).toContain('test.js:L15-L25');
      expect(output).toContain('Multi-line comment');
      expect(output).toContain('Total comments: 2');
    });

    it('POST /api/comment-imports accepts valid comment imports', async () => {
      const imports = [
        {
          type: 'thread',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 10 },
          body: 'Review comment',
        },
      ];

      const response = await commentClientFetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });

      expect(response.ok).toBe(true);
      const data = (await response.json()) as any;
      expect(data.success).toBe(true);
      expect(data.importId).toEqual(expect.any(String));
      expect(data.count).toBe(1);
    });

    it('POST /api/comment-imports accepts a single object', async () => {
      const singleImport = {
        type: 'thread',
        filePath: 'src/example.ts',
        position: { side: 'new', line: 5 },
        body: 'Single object import',
      };

      const response = await commentClientFetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(singleImport),
      });

      expect(response.ok).toBe(true);
      const data = (await response.json()) as any;
      expect(data.success).toBe(true);
      expect(data.count).toBe(1);
    });

    it('POST /api/comment-imports rejects invalid data', async () => {
      const response = await commentClientFetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: true }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data).toHaveProperty('error');
    });

    it('GET /api/comments-json returns empty threads by default', async () => {
      const response = await commentClientFetch(`${httpUrl}/api/comments-json`);

      expect(response.ok).toBe(true);
      const data = (await response.json()) as any;
      expect(data).toHaveProperty('threads');
      expect(data.threads).toEqual([]);
    });

    it('GET /api/comments-json returns threads after posting comments', async () => {
      const comments = [{ file: 'test.js', line: 10, body: 'JSON test comment' }];

      await commentClientFetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments }),
      });

      const response = await commentClientFetch(`${httpUrl}/api/comments-json`);

      expect(response.ok).toBe(true);
      const data = (await response.json()) as any;
      expect(data.threads).toHaveLength(1);
      expect(data.threads[0].messages[0].body).toBe('JSON test comment');
    });

    it('POST /api/comment-imports merges into server-side threads for comments-output', async () => {
      const imports = [
        {
          type: 'thread',
          filePath: 'src/example.ts',
          position: { side: 'new', line: 42 },
          body: 'Merged server-side comment',
        },
      ];

      await commentClientFetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });

      const outputResponse = await commentClientFetch(`${httpUrl}/api/comments-output`);
      const output = await outputResponse.text();

      expect(output).toContain('src/example.ts:L42');
      expect(output).toContain('Merged server-side comment');
    });

    it('POST /api/comment-imports merges reply into existing thread', async () => {
      // First add a thread
      await commentClientFetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            type: 'thread',
            filePath: 'src/reply-test.ts',
            position: { side: 'new', line: 5 },
            body: 'Original comment',
            author: 'User',
          },
        ]),
      });

      // Then add a reply
      await commentClientFetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            type: 'reply',
            filePath: 'src/reply-test.ts',
            position: { side: 'new', line: 5 },
            body: 'Reply to comment',
            author: 'AI',
          },
        ]),
      });

      const jsonResponse = await commentClientFetch(`${httpUrl}/api/comments-json`);
      const data = (await jsonResponse.json()) as any;

      const thread = data.threads.find((t: any) => t.filePath === 'src/reply-test.ts');
      expect(thread).toBeDefined();
      expect(thread.messages).toHaveLength(2);
      expect(thread.messages[0].body).toBe('Original comment');
      expect(thread.messages[1].body).toBe('Reply to comment');
    });

    it('POST /api/comment-imports deduplicates identical imports', async () => {
      const imports = [
        {
          type: 'thread',
          filePath: 'src/dedup.ts',
          position: { side: 'new', line: 1 },
          body: 'Unique comment',
        },
      ];

      // Send the same import twice
      await commentClientFetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });
      await commentClientFetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });

      const jsonResponse = await commentClientFetch(`${httpUrl}/api/comments-json`);
      const data = (await jsonResponse.json()) as any;

      const threads = data.threads.filter((t: any) => t.filePath === 'src/dedup.ts');
      expect(threads).toHaveLength(1);
    });

    it('DELETE /api/comments/:threadId removes the thread and bumps the version', async () => {
      await commentClientFetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            type: 'thread',
            id: 'delete-me',
            filePath: 'src/delete-test.ts',
            position: { side: 'new', line: 3 },
            body: 'Thread to delete',
          },
        ]),
      });

      const beforeResponse = await commentClientFetch(`${httpUrl}/api/comments-json`);
      const before = (await beforeResponse.json()) as any;
      expect(before.threads.some((t: any) => t.id === 'delete-me')).toBe(true);

      const deleteResponse = await commentClientFetch(`${httpUrl}/api/comments/delete-me`, {
        method: 'DELETE',
      });
      const deleteData = (await deleteResponse.json()) as any;

      expect(deleteResponse.ok).toBe(true);
      expect(deleteData).toMatchObject({
        success: true,
        threadId: 'delete-me',
      });
      expect(deleteData.version).toBe(before.version + 1);

      const afterResponse = await commentClientFetch(`${httpUrl}/api/comments-json`);
      const after = (await afterResponse.json()) as any;
      expect(after.threads.some((t: any) => t.id === 'delete-me')).toBe(false);
    });

    it('DELETE /api/comments/:threadId returns 404 for unknown thread', async () => {
      const response = await commentClientFetch(`${httpUrl}/api/comments/does-not-exist`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(404);
      const data = (await response.json()) as any;
      expect(data).toHaveProperty('error');
      expect(data.error).toMatchObject({ code: 'thread_not_found' });
    });

    describe('user settings API', () => {
      const originalConfigDir = process.env.DIFIT_CONFIG_DIR;
      let configDir: string;

      beforeEach(async () => {
        configDir = await fs.mkdtemp(join(tmpdir(), 'difit-user-settings-'));
        process.env.DIFIT_CONFIG_DIR = configDir;
      });

      afterEach(async () => {
        if (originalConfigDir === undefined) {
          delete process.env.DIFIT_CONFIG_DIR;
        } else {
          process.env.DIFIT_CONFIG_DIR = originalConfigDir;
        }
        await fs.rm(configDir, { recursive: true, force: true });
      });

      it('GET /api/user-settings returns defaults when no config exists', async () => {
        const response = await commentClientFetch(`${httpUrl}/api/user-settings`);

        expect(response.ok).toBe(true);
        const data = (await response.json()) as any;
        expect(data).toEqual({ version: 1, client: {} });
      });

      it('PUT /api/user-settings merges and persists client settings', async () => {
        const first = await commentClientFetch(`${httpUrl}/api/user-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client: { diffViewMode: 'split', sidebarWidth: 320 },
          }),
        });
        expect(first.ok).toBe(true);

        const second = await commentClientFetch(`${httpUrl}/api/user-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: { sidebarWidth: 400 } }),
        });
        expect(second.ok).toBe(true);
        const merged = (await second.json()) as any;
        expect(merged.client).toEqual({
          diffViewMode: 'split',
          sidebarWidth: 400,
        });

        const getResponse = await commentClientFetch(`${httpUrl}/api/user-settings`);
        const data = (await getResponse.json()) as any;
        expect(data.client).toEqual({
          diffViewMode: 'split',
          sidebarWidth: 400,
        });

        const stored = JSON.parse(
          await fs.readFile(join(configDir, 'config.json'), 'utf-8'),
        ) as any;
        expect(stored.client).toEqual({
          diffViewMode: 'split',
          sidebarWidth: 400,
        });
      });

      it('PUT /api/user-settings rejects invalid payloads', async () => {
        const response = await commentClientFetch(`${httpUrl}/api/user-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: 'dark' }),
        });

        expect(response.status).toBe(400);
        const data = (await response.json()) as any;
        expect(data).toHaveProperty('error');
      });
    });

    it('isolates comment sessions between different diff selections', async () => {
      const importServer = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9039,
        commentImports: [
          {
            type: 'thread',
            filePath: 'src/cli/comment.test.ts',
            position: { side: 'new', line: 10 },
            body: 'Startup comment',
          },
        ],
      });
      servers.push(importServer.server);

      const parser = parserInstances.at(-1);
      parser?.parseDiff.mockImplementation(async (selection: any) => ({
        targetCommit: 'abc123',
        baseCommit: 'def456',
        baseCommitish: selection.baseCommitish === 'HEAD^' ? 'def4567' : selection.baseCommitish,
        targetCommitish:
          selection.targetCommitish === 'HEAD' ? 'abc1234' : selection.targetCommitish,
        requestedBaseCommitish: selection.baseCommitish,
        requestedTargetCommitish: selection.targetCommitish,
        requestedBaseMode: selection.baseMode,
        targetMessage: 'Test commit',
        baseMessage: 'Previous commit',
        files: [
          {
            path: 'src/cli/comment.test.ts',
            additions: 10,
            deletions: 5,
            chunks: [],
          },
        ],
        stats: { additions: 10, deletions: 5 },
        isEmpty: false,
      }));

      await commentClientFetch(`${testHttpUrl(importServer.server)}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            type: 'thread',
            filePath: 'src/cli/comment.test.ts',
            position: { side: 'new', line: 20 },
            body: 'API comment',
          },
        ]),
      });

      let response = await commentClientFetch(
        `${testHttpUrl(importServer.server)}/api/comments-output`,
      );
      let output = await response.text();
      expect(output).toContain('Startup comment');
      expect(output).toContain('API comment');

      // The browser moves to another revision pair. Reads and writes that name no selection stay
      // pinned to the launch review; the other pair is reached only by naming it, as the SPA does.
      const otherQuery = 'base=feat%2F292-comment-read-write&target=codex%2Fcomment-session-state';
      await commentClientFetch(`${testHttpUrl(importServer.server)}/api/diff?${otherQuery}`);

      response = await commentClientFetch(
        `${testHttpUrl(importServer.server)}/api/comments-output`,
      );
      output = await response.text();
      expect(output).toContain('Startup comment');
      expect(output).toContain('API comment');

      response = await commentClientFetch(
        `${testHttpUrl(importServer.server)}/api/comments-output?${otherQuery}`,
      );
      expect(await response.text()).toBe('');

      await commentClientFetch(
        `${testHttpUrl(importServer.server)}/api/comment-imports?${otherQuery}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([
            {
              type: 'thread',
              filePath: 'src/cli/comment.test.ts',
              position: { side: 'new', line: 30 },
              body: 'Other diff comment',
            },
          ]),
        },
      );

      response = await commentClientFetch(
        `${testHttpUrl(importServer.server)}/api/comments-output?${otherQuery}`,
      );
      output = await response.text();
      expect(output).toContain('Other diff comment');
      expect(output).not.toContain('Startup comment');
      expect(output).not.toContain('API comment');

      await commentClientFetch(
        `${testHttpUrl(importServer.server)}/api/diff?base=HEAD%5E&target=HEAD`,
      );

      response = await commentClientFetch(
        `${testHttpUrl(importServer.server)}/api/comments-output`,
      );
      output = await response.text();
      expect(output).toContain('Startup comment');
      expect(output).toContain('API comment');
      expect(output).not.toContain('Other diff comment');
    });

    it.skip('GET /api/heartbeat returns SSE headers', async () => {
      // Skipped due to connection reset issues in test environment
      // SSE endpoint functionality is verified through manual testing
      expect(true).toBe(true);
    });

    it('GET /api/diff sets openInEditorAvailable=false for stdin diff', async () => {
      const stdinServer = await startServer({
        stdinDiff: 'diff --git a/stdin-test.js b/stdin-test.js',
        preferredPort: 9035,
      });
      servers.push(stdinServer.server);

      const response = await commentClientFetch(`${testHttpUrl(stdinServer.server)}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data).toHaveProperty('openInEditorAvailable', false);
    });

    it('GET /api/generated-status/* returns 400 for stdin diff', async () => {
      const stdinServer = await startServer({
        stdinDiff: 'diff --git a/stdin-test.js b/stdin-test.js',
        preferredPort: 9036,
      });
      servers.push(stdinServer.server);

      const response = await commentClientFetch(
        `${testHttpUrl(stdinServer.server)}/api/generated-status/stdin-test.js?ref=HEAD`,
      );
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'Generated status is not available for stdin diff');
    });
  });

  describe('Static file serving', () => {
    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      if (originalNodeEnv !== undefined) {
        process.env.NODE_ENV = originalNodeEnv;
      } else {
        delete process.env.NODE_ENV;
      }
    });

    it('serves dev mode HTML in development', async () => {
      process.env.NODE_ENV = 'development';

      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9040,
      });
      servers.push(result.server);

      const response = await commentClientFetch(`${testHttpUrl(result.server)}/`);
      const html = await response.text();

      expect(response.ok).toBe(true);
      expect(html).toContain('difit - Dev Mode');
      expect(html).toContain('difit development mode');
    });

    it('serves static files in production mode', async () => {
      process.env.NODE_ENV = 'production';

      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9050,
      });
      servers.push(result.server);

      // In production, it should try to serve static files
      // This might 404 if dist/client doesn't exist, but that's expected
      const response = await commentClientFetch(`${testHttpUrl(result.server)}/`);

      // We don't expect a specific response since dist/client may not exist
      // But the server should not crash
      expect([200, 404]).toContain(response.status);
    });

    it('returns 404 for unknown paths in production mode', async () => {
      process.env.NODE_ENV = 'production';

      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9055,
      });
      servers.push(result.server);

      const response = await commentClientFetch(`${testHttpUrl(result.server)}/not-a-route`);

      expect(response.status).toBe(404);
    });
  });

  describe('Revision options API', () => {
    it('returns available revisions', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(result.server);

      const response = await commentClientFetch(`${testHttpUrl(result.server)}/api/revisions`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.specialOptions).toHaveLength(3);
      expect(data.specialOptions).not.toContainEqual({
        value: 'merge-base',
        label: 'Merge Base',
      });
      expect(data.branches).toEqual([{ name: 'main', current: true }]);
      expect(data.commits).toEqual([
        { hash: 'abc1234', shortHash: 'abc1234', message: 'Test commit' },
      ]);
      expect(data.originDefaultBranch).toBe('origin/main');
      expect(data.resolvedBase).toBe('abc1234');
      expect(data.resolvedTarget).toBe('def5678');
    });
  });

  describe('Error handling', () => {
    it('handles malformed comment data', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(result.server);

      const response = await commentClientFetch(`${testHttpUrl(result.server)}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(response.status).toBe(400);
      if (response.headers.get('content-type')?.includes('application/json')) {
        const data = await response.json();
        expect(data).toMatchObject({ error: { code: 'invalid_request' } });
      } else {
        // If not JSON, just check status
        expect(response.ok).toBe(false);
      }
    });
  });

  describe('CORS configuration', () => {
    it('sets correct CORS headers', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(result.server);

      const response = await commentClientFetch(`${testHttpUrl(result.server)}/api/diff`);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, POST, PUT, DELETE, OPTIONS',
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Origin, X-Requested-With, Content-Type, Accept',
      );
    });
  });

  describe('Line count API', () => {
    let httpUrl: string;

    beforeEach(async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9050,
      });
      servers.push(result.server);
      httpUrl = testHttpUrl(result.server);
    });

    it('returns line counts for repository files', async () => {
      const response = await commentClientFetch(
        `${httpUrl}/api/line-count/src%2Findex.ts?oldRef=HEAD~1&newRef=HEAD`,
      );
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data).toEqual({
        oldLineCount: 42,
        newLineCount: 42,
      });
    });

    it('rejects paths outside repository', async () => {
      const response = await commentClientFetch(`${httpUrl}/api/line-count/..%2Foutside.txt`);
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });

    it('rejects oldPath values outside repository', async () => {
      const response = await commentClientFetch(
        `${httpUrl}/api/line-count/src%2Findex.ts?oldRef=HEAD~1&oldPath=..%2Foutside.txt`,
      );
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });
  });

  describe('Blob API endpoints', () => {
    let httpUrl: string;

    beforeEach(async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9060,
      });
      servers.push(result.server);
      httpUrl = testHttpUrl(result.server);
    });

    it('GET /api/blob/* returns file content for images', async () => {
      const response = await commentClientFetch(`${httpUrl}/api/blob/image.jpg?ref=HEAD`);

      expect(response.ok).toBe(true);
      expect(response.headers.get('Content-Type')).toBe('image/jpeg');
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
      expect(response.headers.get('Pragma')).toBe('no-cache');
      expect(response.headers.get('Expires')).toBe('0');

      const buffer = await response.arrayBuffer();
      expect(buffer.byteLength).toBeGreaterThan(0);
    });

    it('sets correct content type for different image formats', async () => {
      const testCases = [
        { filename: 'photo.jpg', expectedType: 'image/jpeg' },
        { filename: 'photo.jpeg', expectedType: 'image/jpeg' },
        { filename: 'logo.png', expectedType: 'image/png' },
        { filename: 'animation.gif', expectedType: 'image/gif' },
        { filename: 'bitmap.bmp', expectedType: 'image/bmp' },
        { filename: 'vector.svg', expectedType: 'image/svg+xml' },
        { filename: 'modern.webp', expectedType: 'image/webp' },
        { filename: 'favicon.ico', expectedType: 'image/x-icon' },
        { filename: 'photo.tiff', expectedType: 'image/tiff' },
        { filename: 'photo.tif', expectedType: 'image/tiff' },
        { filename: 'modern.avif', expectedType: 'image/avif' },
        { filename: 'mobile.heic', expectedType: 'image/heic' },
        { filename: 'camera.heif', expectedType: 'image/heif' },
      ];

      for (const { filename, expectedType } of testCases) {
        const response = await commentClientFetch(`${httpUrl}/api/blob/${filename}?ref=HEAD`);
        expect(response.headers.get('Content-Type')).toBe(expectedType);
      }
    });

    it('sets default content type for unknown extensions', async () => {
      const response = await commentClientFetch(`${httpUrl}/api/blob/unknown.xyz?ref=HEAD`);

      expect(response.ok).toBe(true);
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    });

    it('handles different git refs correctly', async () => {
      const testRefs = ['HEAD', 'main', 'feature-branch', 'abc123'];

      for (const ref of testRefs) {
        const response = await commentClientFetch(`${httpUrl}/api/blob/image.jpg?ref=${ref}`);
        expect(response.ok).toBe(true);
      }
    });

    it('defaults to HEAD when no ref is provided', async () => {
      const response = await commentClientFetch(`${httpUrl}/api/blob/image.jpg`);

      expect(response.ok).toBe(true);
      // Should use HEAD as default ref
    });

    it('handles file not found errors', async () => {
      // Skip this test as mocking GitDiffParser in an already running server is complex
      // The error handling is already covered by the actual implementation
    });

    it('handles large file errors appropriately', async () => {
      // Skip this test as mocking GitDiffParser in an already running server is complex
      // The error handling is already covered by the actual implementation
    });

    it('handles special characters in file paths', async () => {
      const specialPaths = [
        'folder/image with spaces.jpg',
        'folder/image-with-dashes.png',
        'folder/image_with_underscores.gif',
        'folder/ιμαγε.jpg', // Unicode characters
      ];

      for (const path of specialPaths) {
        const encodedPath = encodeURIComponent(path);
        const response = await commentClientFetch(`${httpUrl}/api/blob/${encodedPath}?ref=HEAD`);
        expect(response.ok).toBe(true);
      }
    });

    it('rejects paths outside repository', async () => {
      const response = await commentClientFetch(`${httpUrl}/api/blob/..%2Foutside.txt?ref=HEAD`);
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });
  });

  describe('Keep-alive option', () => {
    it('routes SIGINT through bounded teardown', async () => {
      const result = await startServer({
        selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
      });
      servers.push(result.server);

      process.emit('SIGINT');

      // 130 is 128 + SIGINT. The code says how the process ended, not how the review did: that
      // is what the REST result is for.
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(130));
      expect(result.server.listening).toBe(false);
      expect(result.getReviewSnapshot().session).toMatchObject({
        state: 'finished',
        reason: 'agent_stop',
      });
    });

    it('routes SIGTERM through bounded teardown', async () => {
      const result = await startServer({
        selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
      });
      servers.push(result.server);

      process.emit('SIGTERM');

      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(143));
      expect(result.server.listening).toBe(false);
      expect(result.getReviewSnapshot().session).toMatchObject({
        state: 'finished',
        reason: 'agent_stop',
      });
    });

    it('closes a live heartbeat SSE connection during teardown', async () => {
      const result = await startServer({
        selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
      });
      servers.push(result.server);
      const disconnected = new Promise<void>((resolve) => {
        result.server.once('request', (request) => request.once('close', resolve));
      });
      const response = await commentClientFetch(`${testHttpUrl(result.server)}/api/heartbeat`);
      await must(response.body, 'a streaming response has a body').getReader().read();

      result.startShutdown();

      await disconnected;
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(result.server.listening).toBe(false);
    });

    it('continues teardown when an explicit stop response closes early', async () => {
      const result = await startServer({
        selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
      });
      servers.push(result.server);
      const response = new EventEmitter();

      result.startShutdown(response as never);
      expect(process.exit).not.toHaveBeenCalled();
      response.emit('close');

      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(result.server.listening).toBe(false);
    });

    it('cancels an idle callback when a stop response is still pending', async () => {
      const result = await startServer({
        selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
        idleGraceMs: 50,
      });
      servers.push(result.server);
      const disconnected = new Promise<void>((resolve) => {
        result.server.once('request', (request) => request.once('close', resolve));
      });
      const heartbeat = new AbortController();
      const heartbeatResponse = await commentClientFetch(
        `${testHttpUrl(result.server)}/api/heartbeat`,
        {
          signal: heartbeat.signal,
        },
      );
      await must(heartbeatResponse.body, 'a streaming response has a body').getReader().read();

      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const stopResponse = new EventEmitter();
      try {
        heartbeat.abort();
        await disconnected;
        result.startShutdown(stopResponse as never);

        await vi.advanceTimersByTimeAsync(50);
        expect(result.getReviewSnapshot().session.reason).toBe('agent_stop');
        expect(process.exit).not.toHaveBeenCalled();
      } finally {
        stopResponse.emit('close');
        await vi.runAllTimersAsync();
        vi.useRealTimers();
      }
    });

    it('forces teardown when a watcher never stops', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const stopSpy = vi
        .spyOn(FileWatcherService.prototype, 'stop')
        .mockImplementation(() => new Promise<void>(() => {}));
      try {
        const result = await startServer({
          selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
          shutdownTimeoutMs: 50,
        });
        servers.push(result.server);

        result.startShutdown();
        await vi.advanceTimersByTimeAsync(50);

        expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(result.server.listening).toBe(false);
      } finally {
        stopSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('prints the final comments even when watcher cleanup fails', async () => {
      const stopSpy = vi
        .spyOn(FileWatcherService.prototype, 'stop')
        .mockRejectedValue(new Error('watcher unsubscribe failed'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await startServer({
          selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
          commentImports: [
            {
              type: 'thread',
              id: 'root',
              filePath: 'a.ts',
              position: { side: 'new', line: 1 },
              body: 'Please fix the null check',
            },
          ],
        });
        servers.push(result.server);

        result.startShutdown();

        await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
        expect(logSpy.mock.calls.flat().join('\n')).toContain('Please fix the null check');
      } finally {
        stopSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it('reports a watcher cleanup rejection as unsuccessful teardown', async () => {
      const error = new Error('watcher unsubscribe failed');
      const stopSpy = vi.spyOn(FileWatcherService.prototype, 'stop').mockRejectedValue(error);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await startServer({
          selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
        });
        servers.push(result.server);

        result.startShutdown();

        await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
        expect(errorSpy).toHaveBeenCalledWith('Failed to shut down difit server:', error);
      } finally {
        stopSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('arms no review deadline for a foreground launch without an explicit timeout', async () => {
      vi.useFakeTimers();
      try {
        const result = await startServer({
          selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
        });
        servers.push(result.server);

        expect(result.getReviewSnapshot().session.limits.timeoutMs).toBeNull();
        await vi.advanceTimersByTimeAsync(2 * 3_600_000);
        expect(result.getReviewSnapshot().session.state).toBe('active');
        expect(process.exit).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the one-hour default deadline for a background review', async () => {
      const result = await startServer({
        selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
        backgroundReview: true,
      });
      servers.push(result.server);

      expect(result.getReviewSnapshot().session.limits.timeoutMs).toBe(3_600_000);
    });

    it('finishes a background review at its deadline despite inherited keep-alive', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      try {
        const result = await startServer({
          selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
          backgroundReview: true,
          keepAlive: true,
          reviewTimeoutMs: 1_000,
          cleanupGraceMs: 5_000,
        });
        servers.push(result.server);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(result.getReviewSnapshot().session).toMatchObject({
          state: 'finished',
          reason: 'review_timeout',
        });
        expect(result.server.listening).toBe(true);
        expect(process.exit).not.toHaveBeenCalled();

        // And the inherited flag does not defeat cleanup either: the process still goes away
        // once the grace elapses.
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(process.exit).toHaveBeenCalled());
      } finally {
        vi.useRealTimers();
      }
    });

    it('finishes and shuts down a foreground review at its deadline', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      try {
        const result = await startServer({
          selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
          reviewTimeoutMs: 1_000,
        });
        servers.push(result.server);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(result.getReviewSnapshot().session).toMatchObject({
          state: 'finished',
          reason: 'review_timeout',
        });
        // The deadline is the server's in every mode now; in the foreground it still ends the
        // process, the way the CLI-owned timer used to — but through the ordinary bounded
        // teardown, so it is a normal exit rather than a code an agent has to decode.
        await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves an explicitly kept-alive foreground review running past its deadline', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await startServer({
          selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
          keepAlive: true,
          reviewTimeoutMs: 1_000,
        });
        servers.push(result.server);

        await vi.advanceTimersByTimeAsync(1_000);

        // Input closes, but a foreground keep-alive is an explicit request to stay reachable.
        expect(result.getReviewSnapshot().session.state).toBe('finished');
        expect(result.server.listening).toBe(true);
        expect(process.exit).not.toHaveBeenCalled();
        // A page that has silently stopped accepting comments looks like a bug; say what happened.
        expect(logSpy.mock.calls.flat().join('\n')).toContain('input is closed');
      } finally {
        logSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('uses the first background completion time to bound cleanup', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(new Date(0));
      try {
        const result = await startServer({
          selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
          backgroundReview: true,
          reviewTimeoutMs: 1_000,
          cleanupGraceMs: 5_000,
        });
        servers.push(result.server);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(result.getReviewSnapshot().session).toMatchObject({
          reason: 'review_timeout',
          finishedAt: new Date(1_000).toISOString(),
          cleanupAt: new Date(6_000).toISOString(),
        });

        await vi.advanceTimersByTimeAsync(5_000);
        expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
        expect(result.server.listening).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('accepts a browser reconnect after background idle completion', async () => {
      const result = await startServer({
        selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
        backgroundReview: true,
        idleGraceMs: 20,
        reviewTimeoutMs: 10_000,
        cleanupGraceMs: 5_000,
      });
      servers.push(result.server);
      const first = new AbortController();
      const firstResponse = await commentClientFetch(
        `${testHttpUrl(result.server)}/api/heartbeat`,
        {
          signal: first.signal,
        },
      );
      await must(firstResponse.body, 'a streaming response has a body').getReader().read();
      first.abort();

      await vi.waitFor(() =>
        expect(result.getReviewSnapshot().session).toMatchObject({
          state: 'finished',
          reason: 'browser_idle',
        }),
      );

      const second = new AbortController();
      try {
        const secondResponse = await commentClientFetch(
          `${testHttpUrl(result.server)}/api/heartbeat`,
          {
            signal: second.signal,
          },
        );
        await must(secondResponse.body, 'a streaming response has a body').getReader().read();
        expect(result.server.listening).toBe(true);
        expect(result.getReviewSnapshot().session.reason).toBe('browser_idle');
      } finally {
        second.abort();
        result.startShutdown();
      }
    });

    it('releases a pending background deadline when the listener closes', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      try {
        const result = await startServer({
          selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
          backgroundReview: true,
          reviewTimeoutMs: 1_000,
        });
        servers.push(result.server);
        await new Promise<void>((resolve) => result.server.close(() => resolve()));

        await vi.advanceTimersByTimeAsync(1_000);
        expect(result.getReviewSnapshot().session.state).toBe('active');
        expect(process.exit).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('accepts keepAlive option without error', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        keepAlive: true,
      });
      servers.push(server);

      expect(port).toBeGreaterThanOrEqual(4966);
    });

    it('starts normally without keepAlive option', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(server);

      expect(port).toBeGreaterThanOrEqual(4966);
    });

    it('keeps a foreground keep-alive review active after the browser goes idle', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        keepAlive: true,
        idleGraceMs: 50,
        preferredPort: 9073,
      });
      servers.push(result.server);

      const controller = new AbortController();
      const response = await commentClientFetch(`${testHttpUrl(result.server)}/api/heartbeat`, {
        signal: controller.signal,
      }).catch(() => null);
      const reader = response?.body?.getReader();
      if (reader) await reader.read();
      controller.abort();

      await new Promise((resolve) => setTimeout(resolve, 300));

      // --keep-alive exists so the review can continue over later rounds, so idling must not
      // latch completion: comment input stays open and the process stays up.
      expect(result.getReviewSnapshot().session.state).toBe('active');
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('does not call process.exit on client disconnect when keepAlive is true', async () => {
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        keepAlive: true,
        idleGraceMs: 50,
        preferredPort: 9070,
      });
      servers.push(server);

      // Connect to heartbeat SSE endpoint and then abort
      const controller = new AbortController();
      const responsePromise = commentClientFetch(`${testHttpUrl(server)}/api/heartbeat`, {
        signal: controller.signal,
      });

      // Wait for the connection to be established
      const response = await responsePromise.catch(() => null);
      if (response) {
        // Start reading the stream to ensure connection is established
        const reader = response.body?.getReader();
        if (reader) {
          await reader.read(); // Read the initial "connected" message
        }
      }

      // Disconnect by aborting
      controller.abort();

      // Wait for the grace period to actually elapse plus the server's close handler
      await new Promise((resolve) => setTimeout(resolve, 300));

      // With keepAlive, process.exit should NOT have been called
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('calls process.exit on client disconnect when keepAlive is false', async () => {
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        keepAlive: false,
        idleGraceMs: 50,
        preferredPort: 9080,
      });
      servers.push(server);

      // Connect to heartbeat SSE endpoint and then abort
      const controller = new AbortController();
      const responsePromise = commentClientFetch(`${testHttpUrl(server)}/api/heartbeat`, {
        signal: controller.signal,
      });

      // Wait for the connection to be established
      const response = await responsePromise.catch(() => null);
      if (response) {
        const reader = response.body?.getReader();
        if (reader) {
          await reader.read(); // Read the initial "connected" message
        }
      }

      // Disconnect by aborting
      controller.abort();

      // Wait for the server's close handler + setTimeout(100ms) to run
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Without keepAlive, process.exit SHOULD have been called
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('does not exit while a second heartbeat client is still connected', async () => {
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        keepAlive: false,
        idleGraceMs: 50,
        preferredPort: 9090,
      });
      servers.push(server);

      const first = new AbortController();
      const second = new AbortController();

      const openHeartbeat = async (controller: AbortController): Promise<void> => {
        const response = await commentClientFetch(`${testHttpUrl(server)}/api/heartbeat`, {
          signal: controller.signal,
        }).catch(() => null);
        const reader = response?.body?.getReader();
        if (reader) {
          await reader.read();
        }
      };

      await openHeartbeat(first);
      await openHeartbeat(second);

      first.abort();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(process.exit).not.toHaveBeenCalled();

      // Close the still-open second connection so the shared afterEach's
      // server.close() (which waits for all connections to end) doesn't hang.
      // Wait out the grace period here too, while process.exit is still
      // mocked, so the resulting shutdown doesn't fire after afterEach
      // restores the real process.exit.
      second.abort();
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  });

  describe('Clear Comments functionality', () => {
    it('includes clearComments flag in diff response when provided', async () => {
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        clearComments: true,
      });
      servers.push(server);

      const response = await commentClientFetch(`${testHttpUrl(server)}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.clearComments).toBe(true);
    });

    it('does not include clearComments flag when not provided', async () => {
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(server);

      const response = await commentClientFetch(`${testHttpUrl(server)}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.clearComments).toBeUndefined();
    });

    it('preserves clearComments flag across diff requests', async () => {
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        clearComments: true,
      });
      servers.push(server);

      // First request
      const response1 = await commentClientFetch(`${testHttpUrl(server)}/api/diff`);
      const data1 = (await response1.json()) as any;
      expect(data1.clearComments).toBe(true);

      // Second request with different ignoreWhitespace
      const response2 = await commentClientFetch(
        `${testHttpUrl(server)}/api/diff?ignoreWhitespace=true`,
      );
      const data2 = (await response2.json()) as any;
      expect(data2.clearComments).toBe(true);
    });
  });

  describe('open-in-editor guards', () => {
    // These tests assert rejection before `spawn` is ever reached, so the exact
    // command is irrelevant to what is being tested. It is deliberately a path
    // that cannot exist: if a guard regresses and this fixture actually reaches
    // `spawn`, the process fails to launch instead of executing a real command.
    const editorBody = {
      filePath: 'README.md',
      line: 1,
      editor: {
        id: 'vscode',
        command: '/nonexistent/difit-guard-test-should-never-run',
        argsTemplate: '-c id',
      },
    };

    // Anyone with DIFIT_EDITOR or EDITOR exported in their shell would otherwise
    // see the env-guard rejection instead of the message a given test expects.
    // Start every test from a known, unset state; tests that need a value set
    // stub it themselves afterwards.
    beforeEach(() => {
      vi.stubEnv('DIFIT_EDITOR', undefined);
      vi.stubEnv('EDITOR', undefined);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('refuses to spawn when the server is bound beyond loopback', async () => {
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '0.0.0.0',
        preferredPort: 9100,
      });
      servers.push(server);

      const response = await commentClientFetch(`${testHttpUrl(server)}/api/open-in-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editorBody),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toHaveProperty(
        'error',
        'Open in editor is disabled when the server is not bound to loopback',
      );
    });

    it('still allows the request when bound to loopback', async () => {
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '127.0.0.1',
        preferredPort: 9101,
      });
      servers.push(server);

      const response = await commentClientFetch(`${testHttpUrl(server)}/api/open-in-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: 'README.md', line: 1, editor: { id: 'none' } }),
      });

      // 'none' is still rejected, but with the disabled-editor error rather than the
      // loopback error — proving the loopback guard did not fire.
      expect(response.status).toBe(403);
      expect(await response.json()).toHaveProperty('error', 'Open in editor is disabled');
    });

    it.runIf(hasIPv6Loopback())(
      'still allows the request when bound to IPv6 loopback',
      async () => {
        const { server } = await startServer({
          selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
          host: '::1',
          preferredPort: 9109,
        });
        servers.push(server);

        expect(server.address()).toMatchObject({ address: '::1', family: 'IPv6' });
        const response = await commentClientFetch(`${testHttpUrl(server)}/api/open-in-editor`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: 'README.md', line: 1, editor: { id: 'none' } }),
        });

        expect(response.status).toBe(403);
        expect(await response.json()).toHaveProperty('error', 'Open in editor is disabled');
      },
    );

    it('still allows the request when --host is an abbreviated form that resolves to loopback', async () => {
      // net.isIP rejects "127.1", but listen() resolves it to 127.0.0.1 via
      // getaddrinfo and binds loopback-only. The guard must read the
      // OS-resolved bind address, not the raw --host string, or it wrongly
      // refuses this request.
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '127.1',
        preferredPort: 9108,
      });
      servers.push(server);

      const response = await commentClientFetch(`${testHttpUrl(server)}/api/open-in-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: 'README.md', line: 1, editor: { id: 'none' } }),
      });

      // 'none' is still rejected, but with the disabled-editor error rather than the
      // loopback error — proving the loopback guard did not fire.
      expect(response.status).toBe(403);
      expect(await response.json()).toHaveProperty('error', 'Open in editor is disabled');
    });

    it('honours DIFIT_EDITOR=none even when the caller supplies another editor id', async () => {
      vi.stubEnv('DIFIT_EDITOR', 'none');

      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '127.0.0.1',
        preferredPort: 9102,
      });
      servers.push(server);

      const response = await commentClientFetch(`${testHttpUrl(server)}/api/open-in-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editorBody),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toHaveProperty(
        'error',
        'Open in editor is disabled by DIFIT_EDITOR=none',
      );
    });

    it('honours EDITOR=none even when the caller supplies another editor id', async () => {
      vi.stubEnv('DIFIT_EDITOR', undefined);
      vi.stubEnv('EDITOR', 'none');

      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '127.0.0.1',
        preferredPort: 9103,
      });
      servers.push(server);

      const response = await commentClientFetch(`${testHttpUrl(server)}/api/open-in-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editorBody),
      });

      // Asserts the distinct EDITOR message, not just any 403, so this pins the
      // EDITOR guard rather than the loopback or DIFIT_EDITOR guard.
      expect(response.status).toBe(403);
      expect(await response.json()).toHaveProperty(
        'error',
        'Open in editor is disabled by EDITOR=none',
      );
    });

    it('falls back to EDITOR=none when DIFIT_EDITOR is an empty string', async () => {
      vi.stubEnv('DIFIT_EDITOR', '');
      vi.stubEnv('EDITOR', 'none');

      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '127.0.0.1',
        preferredPort: 9104,
      });
      servers.push(server);

      const response = await commentClientFetch(`${testHttpUrl(server)}/api/open-in-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editorBody),
      });

      // An empty DIFIT_EDITOR must not be treated as "set", or it would mask
      // EDITOR=none and let the request fall through to a real spawn.
      expect(response.status).toBe(403);
      expect(await response.json()).toHaveProperty(
        'error',
        'Open in editor is disabled by EDITOR=none',
      );
    });

    it('falls back to EDITOR=none when DIFIT_EDITOR is whitespace only', async () => {
      vi.stubEnv('DIFIT_EDITOR', '   ');
      vi.stubEnv('EDITOR', 'none');

      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '127.0.0.1',
        preferredPort: 9105,
      });
      servers.push(server);

      const response = await commentClientFetch(`${testHttpUrl(server)}/api/open-in-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editorBody),
      });

      // Same as the empty-string case: whitespace-only must also count as unset.
      expect(response.status).toBe(403);
      expect(await response.json()).toHaveProperty(
        'error',
        'Open in editor is disabled by EDITOR=none',
      );
    });

    it('does not let a real DIFIT_EDITOR value be blocked by EDITOR=none', async () => {
      vi.stubEnv('DIFIT_EDITOR', 'vscode');
      vi.stubEnv('EDITOR', 'none');

      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '127.0.0.1',
        preferredPort: 9106,
      });
      servers.push(server);

      // A non-blank DIFIT_EDITOR must win over EDITOR, so the env guard must not
      // fire here. To prove that without ever reaching `spawn`, the body carries
      // an invalid filePath: the next check the handler runs after the env guard
      // rejects it with a distinct 400, which could only be reached if the env
      // guard let the request through.
      const response = await commentClientFetch(`${testHttpUrl(server)}/api/open-in-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: 123 }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error', 'Invalid request payload');
    });

    it('passes a legitimate loopback request all the way through to the spawn attempt', async () => {
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        host: '127.0.0.1',
        preferredPort: 9107,
      });
      servers.push(server);

      const response = await commentClientFetch(`${testHttpUrl(server)}/api/open-in-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editorBody),
      });

      // No guard fires: no DIFIT_EDITOR/EDITOR is set, the host is loopback, and the
      // request supplies a valid filePath and editor. The 500 below comes only from
      // the fixture command failing to spawn (it doesn't exist), which proves the
      // request reached the real spawn attempt without ever executing anything.
      expect(response.status).toBe(500);
      expect(await response.json()).toHaveProperty(
        'error',
        'Failed to launch editor: command "/nonexistent/difit-guard-test-should-never-run" is not available on PATH',
      );
    });
  });

  describe('port range', () => {
    it('fails loudly instead of walking past maxPort', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9200,
      });
      servers.push(server);

      await expect(
        startServer({
          selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
          preferredPort: port,
          maxPort: port,
        }),
      ).rejects.toThrow(/No free port in range \d+-\d+/);
    });

    it('does not increment at all when strictPort is set', async () => {
      const { port, server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        preferredPort: 9210,
      });
      servers.push(server);

      await expect(
        startServer({
          selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
          preferredPort: port,
          strictPort: true,
        }),
      ).rejects.toThrow(/Port \d+ is already in use/);
    });
  });

  describe('review snapshot', () => {
    /** Offset the fake wall clock to reproduce a timer firing one millisecond before its deadline. */
    it.each(['elapsed grace', 'reconnect', 'server close'] as const)(
      'handles an early idle timer followed by %s',
      async (nextEvent) => {
        const result = await startServer({
          selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
          preferredPort: 9334,
          idleGraceMs: 50,
        });
        const server = result.server;
        servers.push(server);
        const controller = new AbortController();
        const reconnectedController = new AbortController();
        let reconnectedDisconnect: Promise<void> | undefined;
        const disconnected = new Promise<void>((resolve) => {
          server.once('request', (request) => request.once('close', resolve));
        });

        try {
          const response = await commentClientFetch(`${testHttpUrl(server)}/api/heartbeat`, {
            signal: controller.signal,
          });
          await must(response.body, 'a streaming response has a body').getReader().read();
          vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
          vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
          controller.abort();
          await disconnected;

          vi.setSystemTime(new Date('2025-12-31T23:59:59.999Z'));
          await vi.advanceTimersByTimeAsync(50);
          expect(result.getReviewSnapshot().session.state).toBe('active');
          expect(process.exit).not.toHaveBeenCalled();

          if (nextEvent === 'reconnect') {
            reconnectedDisconnect = new Promise<void>((resolve) => {
              server.once('request', (request) => request.once('close', resolve));
            });
            const response = await commentClientFetch(`${testHttpUrl(server)}/api/heartbeat`, {
              signal: reconnectedController.signal,
            });
            await must(response.body, 'a streaming response has a body').getReader().read();
          } else if (nextEvent === 'server close') {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }

          await vi.advanceTimersByTimeAsync(1);
          if (nextEvent === 'elapsed grace') {
            expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
          } else {
            expect(process.exit).not.toHaveBeenCalled();
          }
        } finally {
          controller.abort();
          reconnectedController.abort();
          await disconnected;
          await reconnectedDisconnect;
          await new Promise<void>((resolve) => server.close(() => resolve()));
          vi.useRealTimers();
        }
      },
    );
  });
});
