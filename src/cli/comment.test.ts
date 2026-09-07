import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createCommentCommand } from './comment.js';
import { must } from '../test/must.js';

describe('createCommentCommand', () => {
  const command = createCommentCommand();

  it('creates a command named "comment"', () => {
    expect(command.name()).toBe('comment');
  });

  it('has "add", "get", and "resolve" subcommands', () => {
    const subcommandNames = command.commands.map((c) => c.name());
    expect(subcommandNames).toContain('add');
    expect(subcommandNames).toContain('get');
    expect(subcommandNames).toContain('resolve');
  });

  describe('add subcommand', () => {
    const addCommand = must(
      command.commands.find((c) => c.name() === 'add'),
      'the add subcommand is registered',
    );

    it('requires --port option', () => {
      const portOption = addCommand.options.find((o) => o.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.mandatory).toBe(true);
    });

    it('accepts optional json argument', () => {
      const args = addCommand.registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].name()).toBe('json');
      expect(args[0].required).toBe(false);
    });
  });

  describe('get subcommand', () => {
    const getCommand = must(
      command.commands.find((c) => c.name() === 'get'),
      'the get subcommand is registered',
    );

    it('requires --port option', () => {
      const portOption = getCommand.options.find((o) => o.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.mandatory).toBe(true);
    });

    it('has --format option with choices', () => {
      const formatOption = getCommand.options.find((o) => o.long === '--format');
      expect(formatOption).toBeDefined();
      expect(formatOption?.defaultValue).toBe('text');
      expect(formatOption?.argChoices).toEqual(['text', 'json']);
    });
  });

  describe('resolve subcommand', () => {
    const resolveCommand = must(
      command.commands.find((c) => c.name() === 'resolve'),
      'the resolve subcommand is registered',
    );

    it('has "remove" alias', () => {
      expect(resolveCommand.aliases()).toContain('remove');
    });

    it('requires --port option', () => {
      const portOption = resolveCommand.options.find((o) => o.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.mandatory).toBe(true);
    });

    it('accepts variadic threadIds argument', () => {
      const args = resolveCommand.registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].name()).toBe('threadIds');
      expect(args[0].required).toBe(true);
      expect(args[0].variadic).toBe(true);
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

describe('comment subcommand integration', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  let originalProcessExit: typeof process.exit;
  let consoleOutput: string[];
  let consoleErrors: string[];

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>();
    globalThis.fetch = mockFetch;

    originalProcessExit = process.exit;
    process.exit = vi.fn() as any;

    consoleOutput = [];
    consoleErrors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.join(' '));
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exit = originalProcessExit;
    vi.restoreAllMocks();
  });

  describe('add', () => {
    it('pins bootstrap identity, version and selection when importing selected comments', async () => {
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse({
            sessionId: 'process-A',
            version: 7,
            review: { sessionId: 'process-A' },
            selection: { baseCommitish: 'base', targetCommitish: 'target', baseMode: 'merge-base' },
            threads: [],
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ success: true, count: 1 }));
      await createCommentCommand().parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '4966',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);
      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:4966/api/comments-json');
      const [url, request] = must(mockFetch.mock.calls[1], 'the import follows the bootstrap read');
      expect(url).toBe(
        'http://localhost:4966/api/comment-imports?base=base&target=target&baseMode=merge-base',
      );
      expect(request?.headers).toEqual({
        'Content-Type': 'application/json',
        'X-Difit-Session': 'process-A',
      });
      expect(JSON.parse(request?.body as string)).toMatchObject({
        baseVersion: 7,
        imports: [{ body: 'Test' }],
      });
    });
    it('sends comment imports to the server', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      mockFetch.mockResolvedValue(jsonResponse({ success: true, importId: 'abc123', count: 1 }));

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '4966',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4966/api/comment-imports?base=other-base&target=other-target&baseMode=direct',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(consoleOutput[0]).toContain('"success":true');
    });

    it('validates JSON before sending', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'add', '--port', '4966', 'not-valid-json']);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(consoleErrors[0]).toContain('Error:');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('reports the status when the error response is not JSON', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      mockFetch.mockResolvedValue(textResponse('<html>502 Bad Gateway</html>', 502));

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '4966',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      expect(consoleErrors[0]).toContain('Comment request failed (502)');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles server error response', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      mockFetch.mockResolvedValue(jsonResponse({ error: 'Bad request' }, 400));

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '4966',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      expect(consoleErrors[0]).toContain('Bad request');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles connection error', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      const fetchError = new TypeError('fetch failed');
      mockFetch.mockRejectedValue(fetchError);

      const command = createCommentCommand();
      await command.parseAsync([
        'node',
        'difit',
        'add',
        '--port',
        '9999',
        '{"type":"thread","filePath":"test.ts","position":{"side":"new","line":1},"body":"Test"}',
      ]);

      expect(consoleErrors[0]).toContain('Cannot connect');
      expect(consoleErrors[0]).toContain('9999');
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('get', () => {
    it('fetches comments in text format by default', async () => {
      mockFetch.mockResolvedValue(textResponse('Comments output text'));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '4966']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments-output');
      expect(consoleOutput[0]).toBe('Comments output text');
    });

    it('fetches comments in json format', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ threads: [{ id: '1' }] }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '4966', '--format', 'json']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4966/api/comments-json');
      expect(consoleOutput[0]).toContain('"threads"');
    });

    it('handles connection error', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '9999']);

      expect(consoleErrors[0]).toContain('Cannot connect');
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles empty text output silently', async () => {
      mockFetch.mockResolvedValue(textResponse('  '));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'get', '--port', '4966']);

      expect(consoleOutput).toHaveLength(0);
    });
  });

  describe('resolve', () => {
    it('chains selected DELETE versions and reports conflicts without retry or retargeting remaining IDs', async () => {
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse({
            sessionId: 'process-A',
            version: 7,
            review: { sessionId: 'process-A' },
            selection: { baseCommitish: 'base', targetCommitish: 'target' },
            threads: [],
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ success: true, version: 8 }))
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: { code: 'version_conflict', message: 'Comment version has changed' },
              version: 9,
              sessionId: 'process-A',
            },
            409,
          ),
        );
      await createCommentCommand().parseAsync([
        'node',
        'difit',
        'remove',
        '--port',
        '4966',
        'one',
        'two',
        'three',
      ]);
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'http://localhost:4966/api/comments/one?base=base&target=target&baseMode=direct&expectedVersion=7',
        { method: 'DELETE', headers: { 'X-Difit-Session': 'process-A' } },
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        3,
        'http://localhost:4966/api/comments/two?base=base&target=target&baseMode=direct&expectedVersion=8',
        { method: 'DELETE', headers: { 'X-Difit-Session': 'process-A' } },
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const printed = must(consoleOutput[0], 'the resolve command printed its JSON result');
      expect(JSON.parse(printed)).toMatchObject({
        success: false,
        resolved: ['one'],
        errors: [
          { threadId: 'two', error: expect.stringContaining('version_conflict') },
          { threadId: 'three', error: expect.stringContaining('version_conflict') },
        ],
      });
    });
    it('sends DELETE requests for each thread ID', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      mockFetch.mockResolvedValue(jsonResponse({ success: true, threadId: 'abc123', version: 2 }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123', 'def456']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4966/api/comments/abc123?base=other-base&target=other-target&baseMode=direct',
        {
          method: 'DELETE',
        },
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4966/api/comments/def456?base=other-base&target=other-target&baseMode=direct',
        {
          method: 'DELETE',
        },
      );
      expect(consoleOutput[0]).toBe(
        JSON.stringify({
          success: true,
          resolved: ['abc123', 'def456'],
          notFound: [],
          errors: [],
        }),
      );
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('works via the remove alias', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      mockFetch.mockResolvedValue(jsonResponse({ success: true, threadId: 'abc123', version: 2 }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'remove', '--port', '4966', 'abc123']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4966/api/comments/abc123?base=other-base&target=other-target&baseMode=direct',
        {
          method: 'DELETE',
        },
      );
      expect(consoleOutput[0]).toContain('"success":true');
    });

    it('URL-encodes thread IDs', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      mockFetch.mockResolvedValue(jsonResponse({ success: true }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'a/b c']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4966/api/comments/a%2Fb%20c?base=other-base&target=other-target&baseMode=direct',
        {
          method: 'DELETE',
        },
      );
    });

    it('reports unknown thread IDs and exits with an error', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, threadId: 'abc123', version: 2 }))
        .mockResolvedValueOnce(jsonResponse({ error: 'Thread not found: missing' }, 404));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123', 'missing']);

      expect(consoleOutput[0]).toBe(
        JSON.stringify({
          success: false,
          resolved: ['abc123'],
          notFound: ['missing'],
          errors: [],
        }),
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('keeps resolving the remaining thread IDs when one error response is not JSON', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      mockFetch
        .mockResolvedValueOnce(textResponse('<html>502 Bad Gateway</html>', 502))
        .mockResolvedValueOnce(jsonResponse({ success: true, threadId: 'def456', version: 2 }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123', 'def456']);

      expect(consoleOutput[0]).toBe(
        JSON.stringify({
          success: false,
          resolved: ['def456'],
          notFound: [],
          errors: [{ threadId: 'abc123', error: 'Comment request failed (502)' }],
        }),
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('collects server errors without dropping remaining thread IDs', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: 'Internal error' }, 500))
        .mockResolvedValueOnce(jsonResponse({ success: true, threadId: 'def456', version: 2 }));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '4966', 'abc123', 'def456']);

      expect(consoleOutput[0]).toBe(
        JSON.stringify({
          success: false,
          resolved: ['def456'],
          notFound: [],
          errors: [{ threadId: 'abc123', error: 'Internal error' }],
        }),
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('handles connection error', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          sessionId: 'process-A',
          version: 0,
          review: null,
          selection: { baseCommitish: 'other-base', targetCommitish: 'other-target' },
          threads: [],
        }),
      );
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      const command = createCommentCommand();
      await command.parseAsync(['node', 'difit', 'resolve', '--port', '9999', 'abc123']);

      expect(consoleErrors[0]).toContain('Cannot connect');
      expect(consoleErrors[0]).toContain('9999');
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});
