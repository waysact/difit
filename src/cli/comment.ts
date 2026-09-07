import { Command, Option } from 'commander';

import { parseCommentImportValue } from '../utils/commentImports.js';
import type { DiffSelection } from '../types/diff.js';
import type { ReviewInfo } from '../types/review.js';

import { detectStdinSource, readStdin } from './utils.js';

interface CommentImportResponse {
  success?: boolean;
  importId?: string;
  count?: number;
  warnings?: string[];
}

interface CommentBootstrap {
  sessionId: string;
  version: number;
  selection: DiffSelection;
  review: ReviewInfo | null;
}

async function responseError(response: Response): Promise<string> {
  // A proxy or a replacement process may answer with HTML. The status is the useful part then, and
  // a `resolve` loop must keep going for its remaining threads instead of dying on a parse error.
  const body = (await response.json().catch(() => ({}))) as {
    error?: string | { code: string; message: string };
  };
  if (typeof body.error === 'string') return body.error;
  if (body.error) return `${body.error.code}: ${body.error.message}`;
  return `Comment request failed (${response.status})`;
}

/** Pin one read so a browser navigation or replacement process cannot redirect queued writes. */
async function readCommentBootstrap(port: number): Promise<CommentBootstrap> {
  const response = await fetch(`http://localhost:${port}/api/comments-json`);
  if (!response.ok) throw new Error(await responseError(response));
  const data = (await response.json()) as CommentBootstrap;
  if (
    !data.selection ||
    typeof data.sessionId !== 'string' ||
    !Number.isSafeInteger(data.version) ||
    data.version < 0 ||
    data.review === undefined
  ) {
    throw new Error(
      'Server does not provide review preconditions; update difit and read comments again',
    );
  }
  return data;
}

function selectionQuery(bootstrap: CommentBootstrap): URLSearchParams {
  return new URLSearchParams({
    base: bootstrap.selection.baseCommitish,
    target: bootstrap.selection.targetCommitish,
    baseMode: bootstrap.selection.baseMode ?? 'direct',
  });
}

function handleCommandError(error: unknown, port: number): never {
  if (error instanceof TypeError && error.message.includes('fetch failed')) {
    console.error(`Error: Cannot connect to difit server on port ${port}. Is the server running?`);
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  process.exit(1);
}

async function parseCommentAddInput(json?: string): Promise<string> {
  if (typeof json === 'string') {
    return json;
  }

  if (detectStdinSource() === 'tty') {
    throw new Error('Provide comment JSON as an argument or via stdin');
  }

  const stdin = await readStdin();
  if (!stdin.trim()) {
    throw new Error('No comment JSON received from stdin');
  }

  return stdin;
}

export function createCommentCommand(): Command {
  const comment = new Command('comment').description(
    'Add, retrieve, or resolve comments on a running difit server',
  );

  comment
    .command('add')
    .description('Add comments to a running difit server')
    .argument('[json]', 'comment import JSON (object or array)')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (json: string | undefined, opts: { port: number }) => {
      try {
        const input = await parseCommentAddInput(json);
        const imports = parseCommentImportValue(input);
        const bootstrap = await readCommentBootstrap(opts.port);

        const response = await fetch(
          `http://localhost:${opts.port}/api/comment-imports?${selectionQuery(bootstrap)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(bootstrap.review ? { 'X-Difit-Session': bootstrap.sessionId } : {}),
            },
            body: JSON.stringify(
              bootstrap.review ? { imports, baseVersion: bootstrap.version } : imports,
            ),
          },
        );

        if (!response.ok) {
          throw new Error(await responseError(response));
        }

        const result = (await response.json()) as CommentImportResponse;
        console.log(
          JSON.stringify({
            success: result.success ?? true,
            importId: result.importId,
            count: result.count ?? imports.length,
            warnings: result.warnings ?? [],
          }),
        );
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  comment
    .command('get')
    .description('Retrieve comments from a running difit server')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (opts: { port: number; format: string }) => {
      try {
        const endpoint = opts.format === 'json' ? '/api/comments-json' : '/api/comments-output';
        const response = await fetch(`http://localhost:${opts.port}${endpoint}`);

        if (!response.ok) {
          console.error('Error: Failed to retrieve comments');
          process.exit(1);
        }

        if (opts.format === 'json') {
          const data: unknown = await response.json();
          console.log(JSON.stringify(data));
        } else {
          const text = await response.text();
          if (text.trim()) {
            console.log(text);
          }
        }
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  comment
    .command('resolve')
    .alias('remove')
    .description('Resolve (remove) comment threads on a running difit server')
    .argument('<threadIds...>', 'thread IDs to resolve')
    .requiredOption('--port <port>', 'port of the running difit server', parseInt)
    .action(async (threadIds: string[], opts: { port: number }) => {
      try {
        const bootstrap = await readCommentBootstrap(opts.port);
        let version = bootstrap.version;
        let blocked: string | undefined;
        const results: Array<{
          threadId: string;
          status: 'resolved' | 'notFound' | 'error';
          error?: string;
        }> = [];
        for (const threadId of threadIds) {
          if (blocked) {
            results.push({ threadId, status: 'error', error: blocked });
            continue;
          }
          const query = selectionQuery(bootstrap);
          if (bootstrap.review) query.set('expectedVersion', String(version));
          const response = await fetch(
            `http://localhost:${opts.port}/api/comments/${encodeURIComponent(threadId)}?${query}`,
            {
              method: 'DELETE',
              ...(bootstrap.review ? { headers: { 'X-Difit-Session': bootstrap.sessionId } } : {}),
            },
          );
          if (response.ok) {
            if (bootstrap.review) {
              const body = (await response.json()) as { version: number };
              version = body.version;
            }
            results.push({ threadId, status: 'resolved' });
          } else if (response.status === 404) {
            results.push({ threadId, status: 'notFound' });
          } else {
            const error = await responseError(response);
            results.push({ threadId, status: 'error', error });
            if (bootstrap.review) blocked = error;
          }
        }

        const resolved = results.filter((r) => r.status === 'resolved').map((r) => r.threadId);
        const notFound = results.filter((r) => r.status === 'notFound').map((r) => r.threadId);
        const errors = results
          .filter((r) => r.status === 'error')
          .map((r) => ({
            threadId: r.threadId,
            error: r.error ?? `Failed to resolve thread ${r.threadId}`,
          }));

        console.log(
          JSON.stringify({
            success: notFound.length === 0 && errors.length === 0,
            resolved,
            notFound,
            errors,
          }),
        );
        if (notFound.length > 0 || errors.length > 0) {
          process.exit(1);
        }
      } catch (error) {
        handleCommandError(error, opts.port);
      }
    });

  return comment;
}
