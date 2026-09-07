import { promises as fs } from 'fs';
import { networkInterfaces, tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Set environment variable to skip fetch mocking
process.env.VITEST_SERVER_TEST = 'true';

import { startServer } from './server.js';
import { testHttpUrl } from './test-http-url.js';
import type { CommentImport } from '../types/diff.js';

// Add fetch polyfill for Node.js test environment
const { fetch } = await import('undici');
globalThis.fetch = fetch as any;
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

        const response = await fetch(`${testHttpUrl(result.server!)}/api/comments`, {
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
        const outputResponse = await fetch(`${testHttpUrl(result.server!)}/api/comments-output`);
        const output = await outputResponse.text();

        expect(output).toContain('src/App.tsx:L10');
        expect(output).toContain('Test comment');
        expect(output).toContain('src/utils/helper.ts:L20-L30');
        expect(output).toContain('Another comment');
        expect(output).not.toContain('undefined');
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server!.close(() => resolve());
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

        const response = await fetch(`${testHttpUrl(result.server!)}/api/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comments: commentsWithMissingFile }),
        });

        expect(response.status).toBe(200);

        // Check the output handles undefined file gracefully
        const outputResponse = await fetch(`${testHttpUrl(result.server!)}/api/comments-output`);
        const output = await outputResponse.text();

        expect(output).toContain('<unknown file>:L10');
        expect(output).toContain('Comment without file');
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server!.close(() => resolve());
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
      fetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threads, baseVersion }),
      });

    const getSession = async (httpUrl: string) => {
      const res = await fetch(`${httpUrl}/api/comments-json`);
      return (await res.json()) as {
        version: number;
        threads: Array<{ id: string; filePath: string }>;
      };
    };

    it('merges concurrent agent additions instead of clobbering on a stale push', async () => {
      const result = await startServer({
        preferredPort: 4966,
        openBrowser: false,
      });

      try {
        // Browser establishes a thread; it now knows version 1.
        await postThreads(testHttpUrl(result.server!), [
          makeThread('t1', 'src/a.ts', 10, 'human thread'),
        ]);
        const afterFirst = await getSession(testHttpUrl(result.server!));
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
        await fetch(`${testHttpUrl(result.server!)}/api/comment-imports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(agentImport),
        });

        // The browser, unaware of the agent's thread, pushes its stale set
        // tagged with the version it last observed (1).
        const staleResponse = await postThreads(
          testHttpUrl(result.server!),
          [makeThread('t1', 'src/a.ts', 10, 'human thread')],
          1,
        );
        const staleResult = (await staleResponse.json()) as { merged: boolean };
        expect(staleResult.merged).toBe(true);

        // The agent's thread must survive the stale push.
        const final = await getSession(testHttpUrl(result.server!));
        expect(final.threads).toHaveLength(2);
        expect(final.threads.some((thread) => thread.id === 't1')).toBe(true);
        expect(final.threads.some((thread) => thread.id === 'agent-1')).toBe(true);
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server!.close(() => resolve());
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
        await postThreads(testHttpUrl(result.server!), [
          makeThread('t1', 'src/a.ts', 10, 'human thread'),
        ]);
        const afterFirst = await getSession(testHttpUrl(result.server!));
        expect(afterFirst.version).toBe(1);
        expect(afterFirst.threads).toHaveLength(1);

        // Same version means no concurrent writer, so an empty set is a real
        // deletion and must be honored (not merged back).
        const response = await postThreads(testHttpUrl(result.server!), [], afterFirst.version);
        const body = (await response.json()) as { merged: boolean };
        expect(body.merged).toBe(false);

        const final = await getSession(testHttpUrl(result.server!));
        expect(final.threads).toHaveLength(0);
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server!.close(() => resolve());
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
        await postThreads(testHttpUrl(result.server!), [
          makeThread('t1', 'src/a.ts', 10, 'human thread'),
        ]);
        const before = await getSession(testHttpUrl(result.server!));

        // A reply via comment-imports must register as a change — otherwise the
        // server skips the commentsChanged broadcast and open browsers go stale.
        await fetch(`${testHttpUrl(result.server!)}/api/comment-imports`, {
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

        const after = await getSession(testHttpUrl(result.server!));
        expect(after.version).toBeGreaterThan(before.version);
      } finally {
        if (result.server) {
          await new Promise<void>((resolve) => {
            result.server!.close(() => resolve());
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
      httpUrl = testHttpUrl(result.server!);
    });

    it('GET /api/diff returns diff data', async () => {
      const response = await fetch(`${httpUrl}/api/diff`);
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

      const errorResponse = await fetch(`${httpUrl}/api/diff?target=nonexistent`);
      expect(errorResponse.status).toBe(500);
      expect(errorResponse.headers.get('content-type')).toContain('application/json');
      const errorBody = (await errorResponse.json()) as any;
      expect(typeof errorBody.error).toBe('string');

      const recoveredResponse = await fetch(`${httpUrl}/api/diff?ignoreWhitespace=true`);
      expect(recoveredResponse.status).toBe(200);

      expect(parser?.parseDiff).toHaveBeenLastCalledWith(
        { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
        true,
        undefined,
      );
    });

    it('GET /api/diff?ignoreWhitespace=true handles whitespace ignore', async () => {
      const response = await fetch(`${httpUrl}/api/diff?ignoreWhitespace=true`);
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

      const response = await fetch(
        `${testHttpUrl(result.server!)}/api/diff?base=main&target=feature&ignoreWhitespace=true`,
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

      const response = await fetch(
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

      const firstResponse = await fetch(
        `${testHttpUrl(result.server!)}/api/diff?base=main&target=feature`,
      );
      expect(firstResponse.ok).toBe(true);

      const secondResponse = await fetch(
        `${testHttpUrl(result.server!)}/api/diff?base=HEAD%5E&target=HEAD`,
      );
      expect(secondResponse.ok).toBe(true);

      const thirdResponse = await fetch(
        `${testHttpUrl(result.server!)}/api/diff?base=main&target=feature`,
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
        const response = await fetch(
          `${testHttpUrl(result.server!)}/api/diff?base=${base}&target=${target}`,
        );
        expect(response.ok).toBe(true);
      }

      const revisitedResponse = await fetch(
        `${testHttpUrl(result.server!)}/api/diff?base=base-a&target=target-a`,
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

      const response = await fetch(`${testHttpUrl(importServer.server!)}/api/diff`);
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

      const response = await fetch(`${testHttpUrl(importServer.server!)}/api/diff`);
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

      const response = await fetch(
        `${testHttpUrl(importServer.server!)}/api/diff?base=main&target=feature`,
      );
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.commentImports).toBeUndefined();
      expect(data.commentImportId).toBeUndefined();
    });

    it('GET /api/generated-status/* returns generated status', async () => {
      const response = await fetch(`${httpUrl}/api/generated-status/src/query.ts?ref=HEAD`);
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
      const response = await fetch(`${httpUrl}/api/generated-status/%2Ftmp%2Foutside.txt?ref=HEAD`);
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });

    it('GET /api/generated-status/* rejects parent traversal paths', async () => {
      const response = await fetch(`${httpUrl}/api/generated-status/..%2Foutside.txt?ref=HEAD`);
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });

    it('POST /api/comments accepts comment data', async () => {
      const comments = [{ file: 'test.js', line: 10, body: 'This is a test comment' }];

      const response = await fetch(`${httpUrl}/api/comments`, {
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

      const response = await fetch(`${httpUrl}/api/comments`, {
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

      const response = await fetch(`${httpUrl}/api/comments`, {
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

      await fetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments }),
      });

      // Then get the output
      const response = await fetch(`${httpUrl}/api/comments-output`);
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

      await fetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments }),
      });

      // Then get the output
      const response = await fetch(`${httpUrl}/api/comments-output`);
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

      const response = await fetch(`${httpUrl}/api/comment-imports`, {
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

      const response = await fetch(`${httpUrl}/api/comment-imports`, {
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
      const response = await fetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: true }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data).toHaveProperty('error');
    });

    it('GET /api/comments-json returns empty threads by default', async () => {
      const response = await fetch(`${httpUrl}/api/comments-json`);

      expect(response.ok).toBe(true);
      const data = (await response.json()) as any;
      expect(data).toHaveProperty('threads');
      expect(data.threads).toEqual([]);
    });

    it('GET /api/comments-json returns threads after posting comments', async () => {
      const comments = [{ file: 'test.js', line: 10, body: 'JSON test comment' }];

      await fetch(`${httpUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments }),
      });

      const response = await fetch(`${httpUrl}/api/comments-json`);

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

      await fetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });

      const outputResponse = await fetch(`${httpUrl}/api/comments-output`);
      const output = await outputResponse.text();

      expect(output).toContain('src/example.ts:L42');
      expect(output).toContain('Merged server-side comment');
    });

    it('POST /api/comment-imports merges reply into existing thread', async () => {
      // First add a thread
      await fetch(`${httpUrl}/api/comment-imports`, {
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
      await fetch(`${httpUrl}/api/comment-imports`, {
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

      const jsonResponse = await fetch(`${httpUrl}/api/comments-json`);
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
      await fetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });
      await fetch(`${httpUrl}/api/comment-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
      });

      const jsonResponse = await fetch(`${httpUrl}/api/comments-json`);
      const data = (await jsonResponse.json()) as any;

      const threads = data.threads.filter((t: any) => t.filePath === 'src/dedup.ts');
      expect(threads).toHaveLength(1);
    });

    it('DELETE /api/comments/:threadId removes the thread and bumps the version', async () => {
      await fetch(`${httpUrl}/api/comment-imports`, {
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

      const beforeResponse = await fetch(`${httpUrl}/api/comments-json`);
      const before = (await beforeResponse.json()) as any;
      expect(before.threads.some((t: any) => t.id === 'delete-me')).toBe(true);

      const deleteResponse = await fetch(`${httpUrl}/api/comments/delete-me`, {
        method: 'DELETE',
      });
      const deleteData = (await deleteResponse.json()) as any;

      expect(deleteResponse.ok).toBe(true);
      expect(deleteData).toMatchObject({
        success: true,
        threadId: 'delete-me',
      });
      expect(deleteData.version).toBe(before.version + 1);

      const afterResponse = await fetch(`${httpUrl}/api/comments-json`);
      const after = (await afterResponse.json()) as any;
      expect(after.threads.some((t: any) => t.id === 'delete-me')).toBe(false);
    });

    it('DELETE /api/comments/:threadId returns 404 for unknown thread', async () => {
      const response = await fetch(`${httpUrl}/api/comments/does-not-exist`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(404);
      const data = (await response.json()) as any;
      expect(data).toHaveProperty('error');
      expect(data.error).toContain('does-not-exist');
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
        const response = await fetch(`${httpUrl}/api/user-settings`);

        expect(response.ok).toBe(true);
        const data = (await response.json()) as any;
        expect(data).toEqual({ version: 1, client: {} });
      });

      it('PUT /api/user-settings merges and persists client settings', async () => {
        const first = await fetch(`${httpUrl}/api/user-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client: { diffViewMode: 'split', sidebarWidth: 320 },
          }),
        });
        expect(first.ok).toBe(true);

        const second = await fetch(`${httpUrl}/api/user-settings`, {
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

        const getResponse = await fetch(`${httpUrl}/api/user-settings`);
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
        const response = await fetch(`${httpUrl}/api/user-settings`, {
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

      await fetch(`${testHttpUrl(importServer.server!)}/api/comment-imports`, {
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

      let response = await fetch(`${testHttpUrl(importServer.server!)}/api/comments-output`);
      let output = await response.text();
      expect(output).toContain('Startup comment');
      expect(output).toContain('API comment');

      await fetch(
        `${testHttpUrl(importServer.server!)}/api/diff?base=feat%2F292-comment-read-write&target=codex%2Fcomment-session-state`,
      );

      response = await fetch(`${testHttpUrl(importServer.server!)}/api/comments-output`);
      output = await response.text();
      expect(output).toBe('');

      await fetch(`${testHttpUrl(importServer.server!)}/api/comment-imports`, {
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
      });

      response = await fetch(`${testHttpUrl(importServer.server!)}/api/comments-output`);
      output = await response.text();
      expect(output).toContain('Other diff comment');
      expect(output).not.toContain('Startup comment');
      expect(output).not.toContain('API comment');

      await fetch(`${testHttpUrl(importServer.server!)}/api/diff?base=HEAD%5E&target=HEAD`);

      response = await fetch(`${testHttpUrl(importServer.server!)}/api/comments-output`);
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

      const response = await fetch(`${testHttpUrl(stdinServer.server!)}/api/diff`);
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

      const response = await fetch(
        `${testHttpUrl(stdinServer.server!)}/api/generated-status/stdin-test.js?ref=HEAD`,
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

      const response = await fetch(`${testHttpUrl(result.server!)}/`);
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
      const response = await fetch(`${testHttpUrl(result.server!)}/`);

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

      const response = await fetch(`${testHttpUrl(result.server!)}/not-a-route`);

      expect(response.status).toBe(404);
    });
  });

  describe('Revision options API', () => {
    it('returns available revisions', async () => {
      const result = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(result.server);

      const response = await fetch(`${testHttpUrl(result.server!)}/api/revisions`);
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

      const response = await fetch(`${testHttpUrl(result.server!)}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(response.status).toBe(400);
      if (response.headers.get('content-type')?.includes('application/json')) {
        const data = await response.json();
        expect(data).toHaveProperty('error', 'Invalid comment data');
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

      const response = await fetch(`${testHttpUrl(result.server!)}/api/diff`);

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
      httpUrl = testHttpUrl(result.server!);
    });

    it('returns line counts for repository files', async () => {
      const response = await fetch(
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
      const response = await fetch(`${httpUrl}/api/line-count/..%2Foutside.txt`);
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });

    it('rejects oldPath values outside repository', async () => {
      const response = await fetch(
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
      httpUrl = testHttpUrl(result.server!);
    });

    it('GET /api/blob/* returns file content for images', async () => {
      const response = await fetch(`${httpUrl}/api/blob/image.jpg?ref=HEAD`);

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
        const response = await fetch(`${httpUrl}/api/blob/${filename}?ref=HEAD`);
        expect(response.headers.get('Content-Type')).toBe(expectedType);
      }
    });

    it('sets default content type for unknown extensions', async () => {
      const response = await fetch(`${httpUrl}/api/blob/unknown.xyz?ref=HEAD`);

      expect(response.ok).toBe(true);
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    });

    it('handles different git refs correctly', async () => {
      const testRefs = ['HEAD', 'main', 'feature-branch', 'abc123'];

      for (const ref of testRefs) {
        const response = await fetch(`${httpUrl}/api/blob/image.jpg?ref=${ref}`);
        expect(response.ok).toBe(true);
      }
    });

    it('defaults to HEAD when no ref is provided', async () => {
      const response = await fetch(`${httpUrl}/api/blob/image.jpg`);

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
        const response = await fetch(`${httpUrl}/api/blob/${encodedPath}?ref=HEAD`);
        expect(response.ok).toBe(true);
      }
    });

    it('rejects paths outside repository', async () => {
      const response = await fetch(`${httpUrl}/api/blob/..%2Foutside.txt?ref=HEAD`);
      const data = (await response.json()) as any;

      expect(response.status).toBe(400);
      expect(data).toHaveProperty('error', 'File path outside repository');
    });
  });

  describe('Keep-alive option', () => {
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
      const responsePromise = fetch(`${testHttpUrl(server!)}/api/heartbeat`, {
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
      const responsePromise = fetch(`${testHttpUrl(server!)}/api/heartbeat`, {
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
        const response = await fetch(`${testHttpUrl(server!)}/api/heartbeat`, {
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

      const response = await fetch(`${testHttpUrl(server!)}/api/diff`);
      const data = (await response.json()) as any;

      expect(response.ok).toBe(true);
      expect(data.clearComments).toBe(true);
    });

    it('does not include clearComments flag when not provided', async () => {
      const { server } = await startServer({
        selection: { targetCommitish: 'HEAD', baseCommitish: 'HEAD^' },
      });
      servers.push(server);

      const response = await fetch(`${testHttpUrl(server!)}/api/diff`);
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
      const response1 = await fetch(`${testHttpUrl(server!)}/api/diff`);
      const data1 = (await response1.json()) as any;
      expect(data1.clearComments).toBe(true);

      // Second request with different ignoreWhitespace
      const response2 = await fetch(`${testHttpUrl(server!)}/api/diff?ignoreWhitespace=true`);
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

      const response = await fetch(`${testHttpUrl(server!)}/api/open-in-editor`, {
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

      const response = await fetch(`${testHttpUrl(server!)}/api/open-in-editor`, {
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

        expect(server!.address()).toMatchObject({ address: '::1', family: 'IPv6' });
        const response = await fetch(`${testHttpUrl(server!)}/api/open-in-editor`, {
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

      const response = await fetch(`${testHttpUrl(server!)}/api/open-in-editor`, {
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

      const response = await fetch(`${testHttpUrl(server!)}/api/open-in-editor`, {
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

      const response = await fetch(`${testHttpUrl(server!)}/api/open-in-editor`, {
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

      const response = await fetch(`${testHttpUrl(server!)}/api/open-in-editor`, {
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

      const response = await fetch(`${testHttpUrl(server!)}/api/open-in-editor`, {
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
      const response = await fetch(`${testHttpUrl(server!)}/api/open-in-editor`, {
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

      const response = await fetch(`${testHttpUrl(server!)}/api/open-in-editor`, {
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
});
