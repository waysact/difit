#!/usr/bin/env node

import { Command } from 'commander';
import { simpleGit, type SimpleGit } from 'simple-git';

import pkg from '../../package.json' with { type: 'json' };
import { startServer } from '../server/server.js';
import { type CommentImport, type DiffSelection } from '../types/diff.js';
import type { ReviewSnapshot } from '../types/review.js';
import { createDiffSelection } from '../utils/diffSelection.js';
import { resolvePublicUrl } from '../utils/public-url.js';
import { DiffMode } from '../types/watch.js';

import {
  shouldReadStdin,
  findUntrackedFiles,
  markFilesIntentToAdd,
  promptUser,
  parseCommentOptions,
  validateDiffArguments,
  validateIdleGraceSeconds,
  validateMaxPort,
  validatePort,
  validateTimeoutSeconds,
  validateCleanupGraceSeconds,
  reviewLifecycleOptions,
  getGitRoot,
  readStdin,
} from './utils.js';
import { createCommentCommand } from './comment.js';
import { getPrPatch, getPrCommentImports } from './github.js';
import {
  BACKGROUND_CHILD_ENV,
  emitBackgroundHandshake,
  ignoreStdioErrorsForBackgroundDaemon,
  startBackgroundProcess,
} from './background.js';

type SpecialArg = 'working' | 'staged' | '.';

function isSpecialArg(arg: string): arg is SpecialArg {
  return arg === 'working' || arg === 'staged' || arg === '.';
}

function resolveDiffSelection(
  commitish: string,
  compareWith?: string,
  mergeBase?: boolean,
): DiffSelection {
  let baseCommitish: string;

  if (compareWith) {
    baseCommitish = compareWith;
  } else if (commitish === 'working') {
    baseCommitish = 'staged';
  } else if (isSpecialArg(commitish)) {
    baseCommitish = 'HEAD';
  } else {
    baseCommitish = commitish + '^';
  }

  return createDiffSelection(baseCommitish, commitish, mergeBase ? 'merge-base' : undefined);
}

function determineDiffMode(selection: DiffSelection, compareWith?: string): DiffMode {
  const { targetCommitish } = selection;

  // If comparing specific commits/branches (not involving HEAD), no watching needed
  // Exception: allow watching when targetCommitish is '.' even with compareWith
  if (compareWith && targetCommitish !== 'HEAD' && targetCommitish !== '.') {
    return DiffMode.SPECIFIC;
  }

  if (targetCommitish === 'working') {
    return DiffMode.WORKING;
  }

  if (targetCommitish === 'staged') {
    return DiffMode.STAGED;
  }

  if (targetCommitish === '.') {
    return DiffMode.DOT;
  }
  // Default mode: HEAD^ vs HEAD or HEAD vs other commits (watch for HEAD changes)
  return DiffMode.DEFAULT;
}

interface CliOptions {
  port?: number;
  host?: string;
  open: boolean;
  comment: string[];
  pr?: string;
  clean?: boolean;
  includeUntracked?: boolean;
  keepAlive?: boolean;
  background?: boolean;
  context?: number;
  mergeBase?: boolean;
  idleGrace?: number;
  cleanupGrace?: number;
  timeout?: number;
  maxPort?: number;
  strictPort?: boolean;
  publicUrl?: string;
  title?: string;
}

const program = new Command();

program
  .name('difit')
  .description('A lightweight Git diff viewer with GitHub-like interface')
  .version(pkg.version, '-v, --version', 'output the version number')
  .enablePositionalOptions()
  .addCommand(createCommentCommand())
  .argument(
    '[commit-ish]',
    'Git commit, tag, branch, HEAD~n reference, or "working"/"staged"/"."',
    'HEAD',
  )
  .argument(
    '[compare-with]',
    'Optional: Compare with this commit/branch (shows diff between commit-ish and compare-with)',
  )
  .option('--port <port>', 'preferred port (auto-assigned if occupied)', parseInt)
  .option('--host <host>', 'host address to bind', '')
  .option('--no-open', 'do not automatically open browser')
  .option(
    '--comment <json>',
    'inject initial review comments (repeatable, accepts a JSON object or array)',
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option('--pr <url>', 'GitHub PR URL to review (e.g., https://github.com/owner/repo/pull/123)')
  .option('--clean', 'start with a clean slate by clearing all existing comments')
  .option('--include-untracked', 'automatically include untracked files in diff')
  .option('--keep-alive', 'keep server running even after browser disconnects')
  .option(
    '--idle-grace <seconds>',
    'seconds with no connected browser before the review is treated as finished',
    parseInt,
  )
  .option('--background', 'keep the server running in the background and output JSON info')
  .option('--context <lines>', 'number of context lines shown around each change', parseInt)
  .option(
    '--merge-base',
    'resolve the base revision with git merge-base before diffing (Git revision mode only)',
  )
  .option(
    '--cleanup-grace <seconds>',
    'seconds a finished background review stays reachable for final processing',
    parseInt,
  )
  .option('--timeout <seconds>', 'give up waiting for a review after N seconds', parseInt)
  .option('--max-port <port>', 'highest port the fallback search may try', parseInt)
  .option('--strict-port', 'fail instead of trying the next port')
  .option('--public-url <template>', 'URL to report; {port} is substituted')
  .option('--title <title>', 'custom window title for the browser tab')
  .action(async (commitish: string, compareWith: string | undefined, options: CliOptions) => {
    try {
      const isBackgroundChild = process.env[BACKGROUND_CHILD_ENV] === '1';
      const backgroundMode = options.background || isBackgroundChild;
      let stdinDiff: string | undefined;
      let stdinReviewLabel = 'diff from stdin';
      let manualCommentImports: CommentImport[] = [];
      let commentImports: CommentImport[] = [];

      if (
        options.context !== undefined &&
        (!Number.isInteger(options.context) || options.context < 0)
      ) {
        console.error('Error: --context must be a non-negative integer');
        process.exit(1);
      }

      const idleGraceValidation = validateIdleGraceSeconds(options.idleGrace);
      if (!idleGraceValidation.valid) {
        console.error(`Error: ${idleGraceValidation.error}`);
        process.exit(1);
      }

      const portValidation = validatePort(options.port);
      if (!portValidation.valid) {
        console.error(`Error: ${portValidation.error}`);
        process.exit(1);
      }

      const maxPortValidation = validateMaxPort(options.maxPort, options.port);
      if (!maxPortValidation.valid) {
        console.error(`Error: ${maxPortValidation.error}`);
        process.exit(1);
      }

      const timeoutValidation = validateTimeoutSeconds(options.timeout);
      if (!timeoutValidation.valid) {
        console.error(`Error: ${timeoutValidation.error}`);
        process.exit(1);
      }

      const cleanupGraceValidation = validateCleanupGraceSeconds(options.cleanupGrace);
      if (!cleanupGraceValidation.valid) {
        console.error(`Error: ${cleanupGraceValidation.error}`);
        process.exit(1);
      }

      // One lifecycle description, shared by both input paths. `backgroundReview` is what gives
      // the server its finite deadline and post-completion cleanup regardless of any inherited
      // keep-alive flag.
      const backgroundLifecycle = reviewLifecycleOptions({
        background: backgroundMode,
        idleGrace: options.idleGrace,
        timeout: options.timeout,
        cleanupGrace: options.cleanupGrace,
      });

      // Whether this invocation will end up reading a diff from stdin or
      // `--pr` rather than resolving one from git -- computed up front,
      // before any of the network or stdin reads below, so a rejection
      // below fails fast instead of after those side effects.
      const usesStdinInput =
        Boolean(options.pr) ||
        shouldReadStdin({
          commitish,
          hasPositionalArgs: program.args.length > 0,
          hasPrOption: false,
        });

      if (options.background && !isBackgroundChild) {
        // The detached child gets /dev/null on fd 0, so a piped diff can never reach it. Left
        // alone it silently reviews the default Git range instead, which looks like a working
        // review of the wrong thing. `--pr` is fine: the child fetches that patch itself.
        if (!options.pr && usesStdinInput) {
          console.error(
            'Error: --background cannot read a diff from stdin, because the detached server has no stdin. ' +
              'Run difit in the foreground and background it with your own job control.',
          );
          process.exit(1);
        }

        await startBackgroundProcess();
        return;
      }

      try {
        manualCommentImports = parseCommentOptions(options.comment);
        commentImports = manualCommentImports;
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : 'Invalid --comment value'}`,
        );
        process.exit(1);
      }

      // A background review is bounded by the server's own deadline and cleanup, so the launcher
      // no longer forces keep-alive on; an explicitly supplied one still cannot make it immortal.
      if (backgroundMode) {
        options.open = false;
      }

      if (options.pr) {
        if (commitish !== 'HEAD' || compareWith) {
          console.error('Error: --pr option cannot be used with positional arguments');
          process.exit(1);
        }

        if (options.mergeBase) {
          console.error('Error: --merge-base option cannot be used with --pr');
          process.exit(1);
        }

        if (options.context !== undefined) {
          console.error('Error: --context option cannot be used with --pr');
          process.exit(1);
        }

        try {
          stdinDiff = getPrPatch(options.pr);
          stdinReviewLabel = options.pr;
        } catch (error) {
          console.error(
            `Error resolving PR: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
          process.exit(1);
        }

        try {
          const prCommentImports = await getPrCommentImports(options.pr);
          commentImports = [...prCommentImports, ...manualCommentImports];
        } catch (error) {
          console.warn(
            `Warning: Failed to load PR review comments: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      } else {
        // usesStdinInput was computed above with hasPrOption: false, which
        // holds in this branch (the `if (options.pr)` above didn't match).
        if (usesStdinInput) {
          if (options.context !== undefined) {
            console.error('Error: --context option cannot be used with stdin diff');
            process.exit(1);
          }
          if (options.mergeBase) {
            console.error('Error: --merge-base option cannot be used with stdin diff');
            process.exit(1);
          }
          // Read unified diff from stdin
          stdinDiff = await readStdin();
          if (!stdinDiff.trim()) {
            console.error('Error: No diff content received from stdin');
            process.exit(1);
          }
        }
      }

      if (stdinDiff) {
        // Start server with stdin diff (including --pr patch).
        const { url, port, getReviewSnapshot } = await startServer({
          stdinDiff,
          preferredPort: options.port,
          host: options.host,
          openBrowser: options.open,
          clearComments: options.clean,
          keepAlive: options.keepAlive,
          maxPort: options.maxPort,
          strictPort: options.strictPort,
          publicUrl: options.publicUrl,
          ...backgroundLifecycle,
          title: options.title,
          ...(commentImports.length > 0 ? { commentImports } : {}),
        });
        const reportedUrl = resolvePublicUrl(options.publicUrl, port, url);

        if (backgroundMode) {
          announceBackgroundReview(getReviewSnapshot());
          if (isBackgroundChild) {
            ignoreStdioErrorsForBackgroundDaemon();
          }
          return;
        }

        console.log(`\n🚀 difit server started on ${reportedUrl}`);
        console.log(`📋 Reviewing: ${stdinReviewLabel}`);
        if (options.keepAlive) {
          console.log('🔒 Keep-alive mode: server will stay running after browser disconnects');
        }
        console.log('\nPress Ctrl+C to stop the server');
        return;
      }

      // Detect git root
      let repoPath: string | undefined;
      try {
        repoPath = getGitRoot();
      } catch {
        // If not in a git repository, fall back to process.cwd()
        repoPath = undefined;
      }

      const selection = resolveDiffSelection(commitish, compareWith, options.mergeBase);

      if (options.mergeBase && isSpecialArg(selection.baseCommitish)) {
        console.error(
          `Error: --merge-base requires a commit-ish base, but resolved base was "${selection.baseCommitish}"`,
        );
        process.exit(1);
      }

      if (selection.targetCommitish === 'working' || selection.targetCommitish === '.') {
        const git = simpleGit(repoPath);
        if (isBackgroundChild && !options.includeUntracked) {
          // Skip interactive prompts in detached background mode, where nobody is watching for
          // the question.
        } else {
          await handleUntrackedFiles(git, options.includeUntracked);
        }
      }

      const validation = validateDiffArguments(selection.targetCommitish, compareWith);
      if (!validation.valid) {
        console.error(`Error: ${validation.error}`);
        process.exit(1);
      }

      const { url, port, isEmpty, getReviewSnapshot } = await startServer({
        selection,
        preferredPort: options.port,
        host: options.host,
        openBrowser: options.open,
        clearComments: options.clean,
        keepAlive: options.keepAlive,
        contextLines: options.context,
        diffMode: determineDiffMode(selection, compareWith),
        repoPath,
        maxPort: options.maxPort,
        strictPort: options.strictPort,
        publicUrl: options.publicUrl,
        ...backgroundLifecycle,
        title: options.title,
        ...(commentImports.length > 0 ? { commentImports } : {}),
      });
      const reportedUrl = resolvePublicUrl(options.publicUrl, port, url);

      if (backgroundMode) {
        announceBackgroundReview(getReviewSnapshot());
        if (isBackgroundChild) {
          ignoreStdioErrorsForBackgroundDaemon();
        }
        return;
      }

      console.log(`\n🚀 difit server started on ${reportedUrl}`);
      console.log(`📋 Reviewing: ${selection.targetCommitish}`);

      if (options.keepAlive) {
        console.log('🔒 Keep-alive mode: server will stay running after browser disconnects');
      }

      if (options.clean) {
        console.log('🧹 Starting with a clean slate - all existing comments will be cleared');
      }

      if (isEmpty) {
        console.log(
          '\n! \x1b[33mNo differences found. Browser will not open automatically.\x1b[0m',
        );
        console.log(`   Server is running at ${reportedUrl} if you want to check manually.\n`);
      } else if (options.open) {
        console.log('🌐 Opening browser...\n');
      } else {
        console.log('💡 Use --open to automatically open browser\n');
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
  });

/**
 * Hand the parent everything it needs to reach this review, once the listener, the store, the
 * mutation routes and the completion timers are all live. Exactly one JSON document goes out; the
 * review itself is read back over REST, never from this stream.
 *
 * Every field comes from the snapshot, so what the launcher prints and what `/api/session`
 * reports cannot drift apart.
 */
function announceBackgroundReview(snapshot: ReviewSnapshot): void {
  emitBackgroundHandshake({
    sessionId: snapshot.session.sessionId,
    port: snapshot.session.port,
    pid: snapshot.session.pid,
    publicUrl: snapshot.session.publicUrl,
    apiUrl: snapshot.session.apiUrl,
    url: snapshot.session.publicUrl,
    cursor: 0,
  });
}

void program.parseAsync();

async function handleUntrackedFiles(git: SimpleGit, addAutomatically?: boolean): Promise<void> {
  const files = await findUntrackedFiles(git);
  if (files.length === 0) {
    return;
  }

  const shouldAdd = addAutomatically || (await promptUserToIncludeUntracked(files));

  if (shouldAdd) {
    await markFilesIntentToAdd(git, files);
    console.log('✅ Files added with --intent-to-add');
    const filesAsArgs = files.join(' ');
    console.log(`   💡 To undo this, run \`git reset -- ${filesAsArgs}\``);
  } else {
    console.log('i Untracked files will not be shown in diff');
  }
}

async function promptUserToIncludeUntracked(files: string[]): Promise<boolean> {
  console.log(`\n📝 Found ${files.length} untracked file(s):`);
  for (const file of files) {
    console.log(`    - ${file}`);
  }

  return await promptUser(
    '\n❓ Would you like to include these untracked files in the diff review? (Y/n): ',
  );
}
