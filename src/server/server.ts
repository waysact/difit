import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { randomUUID } from 'node:crypto';
import { type Server } from 'http';
import { type Socket } from 'node:net';
import { join, dirname, isAbsolute, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import express, { type Express, type Request, type Response } from 'express';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { type DiffMode } from '../types/watch.js';
import { formatCommentsOutput } from '../utils/commentFormatting.js';
import {
  mergeCommentImports,
  mergeCommentThreads,
  normalizeCommentImports,
  serializeCommentImports,
} from '../utils/commentImports.js';
import {
  buildEditorSpawnSpec,
  CUSTOM_EDITOR_ID,
  NONE_EDITOR_ID,
  resolveEditorOption,
  resolveEnvEditor,
} from '../utils/editorOptions.js';
import { getFileExtension } from '../utils/fileUtils.js';
import { effectivePreferredPort } from '../utils/ports.js';
import { resolvePublicUrl } from '../utils/public-url.js';
import { listenerApiUrl } from '../utils/listener-url.js';

import { FileWatcherService } from './file-watcher.js';
import { GitDiffParser } from './git-diff.js';
import { isLoopbackAddress } from './loopback.js';
import { ReviewLifecycle } from './review-lifecycle.js';
import { createReviewRouter } from './review-api.js';
import { requireReviewIdentity, reviewBodyParser, reviewErrors } from './review-http.js';
import { createReviewStore } from './review-store.js';
import type { ReviewSnapshot } from '../types/review.js';
import { runBoundedShutdown } from './shutdown.js';
import { parseUserSettingsPatch, readUserConfig, updateUserClientSettings } from './user-config.js';

import {
  type BaseMode,
  type CommentImport,
  type Comment,
  type CommentThread,
  type DiffCommentThread,
  type DiffResponse,
  type DiffSelection,
  type GeneratedStatusResponse,
  type RevisionsResponse,
} from '@/types/diff.js';
import {
  createDiffSelection,
  diffSelectionsEqual,
  getDiffSelectionKey,
  normalizeBaseMode,
} from '../utils/diffSelection.js';

export interface ServerOptions {
  selection?: DiffSelection;
  stdinDiff?: string;
  preferredPort?: number;
  host?: string;
  openBrowser?: boolean;
  ignoreWhitespace?: boolean;
  clearComments?: boolean;
  commentImports?: CommentImport[];
  keepAlive?: boolean;
  /** A detached review completes first, then exits after its cleanup grace. */
  backgroundReview?: boolean;
  /** Maximum lifetime of the review after its listener is ready. */
  reviewTimeoutMs?: number;
  /** Maximum final-processing window for a completed background review. */
  cleanupGraceMs?: number;
  /** Milliseconds with zero heartbeat clients before the review counts as idle. */
  idleGraceMs?: number;
  diffMode?: DiffMode;
  repoPath?: string;
  contextLines?: number;
  /** Highest port the fallback search may try. Defaults to preferredPort + 99. */
  maxPort?: number;
  /** When true, fail immediately instead of trying the next port. */
  strictPort?: boolean;
  /** URL reported to consumers instead of the bound one; `{port}` is substituted. */
  publicUrl?: string;
  /**
   * How long the claimed idle shutdown may spend on cleanup before the exit is
   * forced. Defaults to `SHUTDOWN_WATCHDOG_MS`; set only so a test does not
   * have to wait the real bound out.
   */
  shutdownTimeoutMs?: number;
}

const GENERATED_STATUS_CACHE_TTL_MS = 60_000;
const MAX_DIFF_CACHE_ENTRIES = 8;

function createDiffCacheKey(selection: DiffSelection, ignoreWhitespace: boolean) {
  return `${getDiffSelectionKey(selection)}\u0000${ignoreWhitespace ? '1' : '0'}`;
}

function getCachedDiffResponse(
  cache: Map<string, DiffResponse>,
  key: string,
): DiffResponse | undefined {
  const cached = cache.get(key);
  if (!cached) {
    return undefined;
  }

  // Refresh insertion order to keep the most recently used entry.
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function setCachedDiffResponse(cache: Map<string, DiffResponse>, key: string, value: DiffResponse) {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);

  while (cache.size > MAX_DIFF_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    cache.delete(oldestKey);
  }
}

interface CommentSessionState {
  threads: DiffCommentThread[];
  version: number;
}

function createResolvedCommentSelection(
  responseDiffData: DiffResponse,
  fallbackSelection: DiffSelection,
  stdinDiff: boolean,
): DiffSelection {
  const baseCommitish =
    responseDiffData.baseCommitish ?? (stdinDiff ? 'stdin' : fallbackSelection.baseCommitish);
  const targetCommitish =
    responseDiffData.targetCommitish ?? (stdinDiff ? 'stdin' : fallbackSelection.targetCommitish);
  const baseMode = responseDiffData.requestedBaseMode ?? fallbackSelection.baseMode;

  return createDiffSelection(baseCommitish, targetCommitish, baseMode);
}

function createCommentSessionKey(selection: DiffSelection): string {
  return getDiffSelectionKey(selection);
}

/** Selected legacy defaults apply only to absent fields; malformed supplied values must not erase state. */
function validateSelectedCommentPayload(payload: Record<string, unknown>): void {
  function invalid(field: string): never {
    throw Object.assign(new Error(`Invalid comment field: ${field}`), { code: 'invalid_request' });
  }
  const record = (value: unknown): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('entry');
    return value as Record<string, unknown>;
  };
  const stringField = (entry: Record<string, unknown>, field: string, nonempty = false): void => {
    if (!(field in entry)) return;
    const value = entry[field];
    if (typeof value !== 'string' || (nonempty && value.trim().length === 0)) invalid(field);
  };
  const positiveLine = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const legacy = (entry: Record<string, unknown>, kind: 'comment' | 'thread' | 'message'): void => {
    stringField(entry, 'id', true);
    for (const field of kind === 'comment' ? ['timestamp'] : ['createdAt', 'updatedAt'])
      stringField(entry, field, true);
    if (kind !== 'thread') {
      stringField(entry, 'body');
      stringField(entry, 'author');
    }
    if (kind === 'message') return;
    stringField(entry, 'file', true);
    stringField(entry, 'codeContent');
    if ('side' in entry && entry.side !== 'old' && entry.side !== 'new') invalid('side');
    if ('line' in entry && !positiveLine(entry.line)) {
      const line = entry.line;
      if (
        !Array.isArray(line) ||
        line.length !== 2 ||
        !positiveLine(line[0]) ||
        !positiveLine(line[1]) ||
        line[0] > line[1]
      )
        invalid('line');
    }
    if (kind === 'thread') {
      if ('resolved' in entry && typeof entry.resolved !== 'boolean') invalid('resolved');
      if ('messages' in entry) {
        if (!Array.isArray(entry.messages)) invalid('messages');
        for (const message of entry.messages) legacy(record(message), 'message');
      }
    }
  };
  for (const field of ['threads', 'comments']) {
    if (field in payload && !Array.isArray(payload[field])) invalid(field);
  }
  const threads = Array.isArray(payload.threads);
  const entries = (threads ? payload.threads : payload.comments) as unknown[];
  for (const value of entries) {
    const entry = record(value);
    if (threads && ('filePath' in entry || 'position' in entry || 'codeSnapshot' in entry)) {
      if (!('filePath' in entry) || !('position' in entry)) invalid('canonical thread');
      continue;
    }
    legacy(entry, threads ? 'thread' : 'comment');
  }
}

export async function startServer(options: ServerOptions): Promise<{
  port: number;
  url: string;
  isEmpty?: boolean;
  server: Server;
  getReviewSnapshot: () => ReviewSnapshot;
  /** Starts the server-owned bounded teardown coordinator. */
  startShutdown: (response?: Response) => void;
}> {
  const app = express();
  // Set once `listen` succeeds, below, from the OS-resolved bind address
  // (`server.address()`) rather than the raw `--host` string: `net.isIP`
  // rejects abbreviated IPv4 forms (`127.1`) that `listen` still resolves to
  // loopback, so classifying the resolved address is what keeps this guard —
  // and the startup warning that shares it — from over-blocking. No request
  // can reach the route below before `listen`'s callback fires, so the guard
  // never reads this before it holds the real verdict. Defaults to `false`,
  // the safe direction, in case that ever changes.
  let serverBoundToLoopback = false;
  const repositoryPath = resolve(options.repoPath ?? process.cwd());
  const repositoryId = createHash('sha256').update(repositoryPath).digest('hex');
  const initialCommentImports = options.commentImports || [];
  const initialSelection = options.selection ?? createDiffSelection('', '');
  const commentImportId =
    initialCommentImports.length > 0
      ? createHash('sha256').update(serializeCommentImports(initialCommentImports)).digest('hex')
      : undefined;
  const parser = new GitDiffParser(repositoryPath);
  const fileWatcher = new FileWatcherService();
  const generatedStatusCache = new Map<
    string,
    { value: GeneratedStatusResponse; expiresAt: number }
  >();
  const diffDataCache = new Map<string, DiffResponse>();
  const initialIgnoreWhitespace = options.ignoreWhitespace || false;
  const parseBaseMode = (value: unknown): BaseMode | undefined => {
    if (value === 'merge-base') {
      return 'merge-base';
    }

    return undefined;
  };

  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  // Skip validation if using stdin diff
  if (!options.stdinDiff) {
    const isValidCommit = await parser.validateCommit(initialSelection.targetCommitish);
    if (!isValidCommit) {
      throw new Error(`Invalid or non-existent commit: ${initialSelection.targetCommitish}`);
    }
  }

  // Generate initial diff data for isEmpty check
  let initialDiffData: DiffResponse;
  if (options.stdinDiff) {
    // Parse stdin diff directly
    initialDiffData = parser.parseStdinDiff(options.stdinDiff);
  } else {
    initialDiffData = await parser.parseDiff(
      initialSelection,
      initialIgnoreWhitespace,
      options.contextLines,
    );
    setCachedDiffResponse(
      diffDataCache,
      createDiffCacheKey(initialSelection, initialIgnoreWhitespace),
      initialDiffData,
    );
  }

  // Function to invalidate cache when file changes are detected
  const invalidateCache = () => {
    diffDataCache.clear();
    generatedStatusCache.clear();
    parser.clearResolvedCommitCache();
  };

  // Track current revisions for cache invalidation
  let currentSelection = initialSelection;
  let currentCommentSelection = createResolvedCommentSelection(
    initialDiffData,
    initialSelection,
    Boolean(options.stdinDiff),
  );

  // The snapshot reports the revision pair difit was launched with. Reading
  // `currentCommentSelection` instead would let a human switching revisions in the
  // browser silently redirect what the waiting agent receives.
  const launchCommentSelection = currentCommentSelection;
  const launchSelectionKey = createCommentSessionKey(launchCommentSelection);

  // Assigned once the listener binds, further down; declared here because the routes defined
  // above that point close over it.
  let publicUrl = '';

  function parseRepositoryRelativePath(filepath: unknown):
    | { ok: true; path: string }
    | {
        ok: false;
        error: 'Invalid file path' | 'File path outside repository';
      } {
    if (typeof filepath !== 'string' || filepath.length === 0) {
      return { ok: false, error: 'Invalid file path' };
    }

    const normalizedFilepath = filepath.replace(/\\/g, '/');
    const hasParentTraversal = normalizedFilepath.split('/').some((segment) => segment === '..');
    if (isAbsolute(filepath) || normalizedFilepath.startsWith('/') || hasParentTraversal) {
      return { ok: false, error: 'File path outside repository' };
    }

    const resolvedPath = resolve(repositoryPath, normalizedFilepath);
    if (resolvedPath !== repositoryPath && !resolvedPath.startsWith(`${repositoryPath}${sep}`)) {
      return { ok: false, error: 'File path outside repository' };
    }

    return { ok: true, path: normalizedFilepath };
  }

  interface EditorRequest {
    readonly id: string | undefined;
    readonly command: string | undefined;
    readonly argsTemplate: string | undefined;
  }

  function parseEditorRequest(value: unknown): EditorRequest {
    if (!value || typeof value !== 'object') {
      return { id: undefined, command: undefined, argsTemplate: undefined };
    }
    const candidate = value as {
      id?: unknown;
      command?: unknown;
      argsTemplate?: unknown;
    };
    return {
      id: typeof candidate.id === 'string' ? candidate.id : undefined,
      command: typeof candidate.command === 'string' ? candidate.command : undefined,
      argsTemplate: typeof candidate.argsTemplate === 'string' ? candidate.argsTemplate : undefined,
    };
  }

  const idleGraceMs = options.idleGraceMs ?? 10_000;
  const backgroundReview = options.backgroundReview ?? false;
  // Only a background review gets a deadline by default: it is what ends a review nobody opens. A
  // foreground launch keeps upstream's behaviour and runs until told otherwise.
  const reviewTimeoutMs = options.reviewTimeoutMs ?? (backgroundReview ? 3_600_000 : null);
  const cleanupGraceMs = options.cleanupGraceMs ?? 300_000;

  const logHuman = (message: string): void => {
    console.log(message);
  };

  const lifecycle = new ReviewLifecycle(idleGraceMs);
  let idleTimer: NodeJS.Timeout | null = null;
  let reviewTimeoutTimer: NodeJS.Timeout | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;
  let shutdownClaimed = false;
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  const heartbeatResponses = new Set<Response>();
  const watchResponses = new Set<Response>();

  /**
   * Claims the single shutdown this server instance is allowed to perform. The idle path, the
   * review deadline, an explicit HTTP stop and the signal handlers are independent and
   * asynchronous; whichever claims first proceeds, and every later caller gets `false` back and
   * must not exit.
   */
  function claimShutdown(): boolean {
    if (shutdownClaimed) {
      return false;
    }
    shutdownClaimed = true;
    return true;
  }

  const commentSessions = new Map<string, CommentSessionState>();
  const initialCommentThreads = mergeCommentImports([], initialCommentImports).threads;
  const reviewStore = createReviewStore({
    sessionId: randomUUID(),
    selectionKey: launchSelectionKey,
    initialThreads: initialCommentThreads,
    selection: {
      requestedBase: initialSelection.baseCommitish,
      requestedTarget: initialSelection.targetCommitish,
      resolvedBase: launchCommentSelection.baseCommitish,
      resolvedTarget: launchCommentSelection.targetCommitish,
      baseMode: normalizeBaseMode(launchCommentSelection.baseMode),
    },
    limits: { idleGraceMs, timeoutMs: reviewTimeoutMs, cleanupGraceMs },
    now: () => new Date(),
    autoCleanup: backgroundReview,
  });
  let broadcastVersion = reviewStore.snapshot().version;
  let broadcastCursor = reviewStore.snapshot().cursor;
  // Completion advances the journal cursor without changing the comment collection, so review
  // notifications follow the cursor while comment notifications follow the version. Gating both
  // on the version would silently drop the `review.finished` notification the SPA needs to close
  // its input.
  const unsubscribeBroadcast = reviewStore.subscribe(() => {
    const { version, cursor, session } = reviewStore.snapshot();
    const timestamp = new Date().toISOString();
    if (version !== broadcastVersion) {
      broadcastVersion = version;
      fileWatcher.broadcast({
        type: 'commentsChanged',
        version,
        timestamp,
      });
    }
    if (cursor !== broadcastCursor) {
      broadcastCursor = cursor;
      fileWatcher.broadcast({
        type: 'reviewChanged',
        sessionId: session.sessionId,
        cursor,
        timestamp,
      });
    }
  });

  /** Arm exactly one background cleanup from the completion timestamp the store published. */
  const scheduleBackgroundCleanup = (): void => {
    const { session } = reviewStore.snapshot();
    if (!backgroundReview || session.state !== 'finished' || cleanupTimer || !session.cleanupAt) {
      return;
    }
    if (reviewTimeoutTimer) {
      clearTimeout(reviewTimeoutTimer);
      reviewTimeoutTimer = null;
    }
    const remainingMs = Math.max(0, new Date(session.cleanupAt).getTime() - Date.now());
    cleanupTimer = setTimeout(() => startShutdown(), remainingMs).unref();
  };
  const unsubscribeCleanupScheduler = reviewStore.subscribe(scheduleBackgroundCleanup);

  const clearLifecycleTimers = (): void => {
    for (const timer of [idleTimer, reviewTimeoutTimer, cleanupTimer]) {
      if (timer) clearTimeout(timer);
    }
    idleTimer = null;
    reviewTimeoutTimer = null;
    cleanupTimer = null;
  };

  const waitForResponse = (response: Response): Promise<void> =>
    new Promise((resolveResponse) => {
      const done = (): void => {
        response.off('finish', done);
        response.off('close', done);
        resolveResponse();
      };
      response.once('finish', done);
      response.once('close', done);
    });

  const closeListener = async (): Promise<void> => {
    const listener = server;
    if (!listener || !listener.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => {
      listener.close((error) => (error ? rejectClose(error) : resolveClose()));
      for (const socket of sockets) socket.destroy();
    });
  };

  const removeSignalHandlers = (): void => {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
  };

  /** Runs every process-ending path through the one synchronous shutdown claim. */
  const startShutdownWithExitCode = (response: Response | undefined, exitCode: number): void => {
    if (!claimShutdown()) return;
    clearLifecycleTimers();
    const responseFinished = response ? waitForResponse(response) : Promise.resolve();
    reviewStore.beginStop();
    void runBoundedShutdown({
      exitCode,
      failureExitCode: exitCode === 0 ? 1 : exitCode,
      exit: (code) => process.exit(code),
      reportError: (error) => console.error('Failed to shut down difit server:', error),
      ...(options.shutdownTimeoutMs === undefined ? {} : { timeoutMs: options.shutdownTimeoutMs }),
      run: async () => {
        await responseFinished;
        for (const sseResponse of heartbeatResponses) sseResponse.end();
        for (const sseResponse of watchResponses) sseResponse.end();
        await closeListener();
        // The person's comments are the point of the run. Print them before any teardown step that
        // can fail, so a watcher unsubscribe error cannot swallow them on the way out.
        outputFinalComments();
        try {
          await fileWatcher.stop();
        } finally {
          clearLifecycleTimers();
          unsubscribeBroadcast();
          unsubscribeCleanupScheduler();
          removeSignalHandlers();
        }
      },
    }).catch(() => {
      process.exitCode = exitCode === 0 ? 1 : exitCode;
    });
  };

  /** Starts bounded teardown after an optional HTTP response has settled. */
  function startShutdown(response?: Response): void {
    startShutdownWithExitCode(response, 0);
  }

  function handleSigint(): void {
    startShutdownWithExitCode(undefined, 130);
  }

  function handleSigterm(): void {
    startShutdownWithExitCode(undefined, 143);
  }

  app.use(
    '/api',
    createReviewRouter({
      store: reviewStore,
      shutdown: startShutdown,
    }),
  );

  const selectedComments = express.Router();
  const mutationSelections = new WeakMap<Request, DiffSelection>();
  selectedComments.use((req, res, next) => {
    const mutation =
      (req.method === 'POST' && /^\/(comments|comment-imports)\/?$/i.test(req.path)) ||
      (req.method === 'DELETE' && /^\/comments\/[^/]+\/?$/i.test(req.path));
    if (!mutation) {
      next('router');
      return;
    }
    const selection = getCommentSelectionFromQuery(req.query);
    mutationSelections.set(req, selection);
    if (createCommentSessionKey(selection) !== launchSelectionKey) {
      next('router');
      return;
    }
    res.set('Cache-Control', 'no-store');
    requireReviewIdentity(req, reviewStore);
    next();
  });
  selectedComments.use(reviewBodyParser());
  selectedComments.use(reviewBodyParser(express.text()));
  selectedComments.post('/comments', (req, res) => {
    const body = selectedBody(req.body);
    const current = reviewStore.checkUserVersion(body.baseVersion);
    if (!Array.isArray(body.threads) && !Array.isArray(body.comments)) {
      throw Object.assign(new Error('Expected a threads array'), { code: 'invalid_request' });
    }
    validateSelectedCommentPayload(body);
    const snapshot = reviewStore.replaceUserThreads(parseCommentsPayload(body), current.version);
    res.json({
      success: true,
      merged: false,
      version: snapshot.version,
      threads: snapshot.threads,
    });
  });
  selectedComments.post('/comment-imports', (req, res) => {
    const body = selectedBody(req.body);
    const current = reviewStore.checkUserVersion(body.baseVersion);
    let imports: CommentImport[];
    try {
      if (!Array.isArray(body.imports)) throw new Error('Expected an imports array');
      imports = normalizeCommentImports(body.imports);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw Object.assign(error, { code: 'invalid_request' });
    }
    const merged = mergeCommentImports(current.threads, imports);
    const snapshot = reviewStore.replaceUserThreads(merged.threads, current.version);
    res.json({
      success: true,
      changed: snapshot.version !== current.version,
      version: snapshot.version,
      count: imports.length,
      importId: createHash('sha256').update(serializeCommentImports(imports)).digest('hex'),
      warnings: merged.warnings,
    });
  });
  selectedComments.delete('/comments/:threadId', (req, res) => {
    const raw = req.query.expectedVersion;
    if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw))) {
      throw Object.assign(new Error('Expected a safe nonnegative integer version'), {
        code: 'invalid_request',
      });
    }
    const current = reviewStore.checkUserVersion(raw === undefined ? undefined : Number(raw));
    const threads = current.threads.filter((thread) => thread.id !== req.params.threadId);
    if (threads.length === current.threads.length)
      throw Object.assign(new Error('Review thread does not exist'), { code: 'thread_not_found' });
    const snapshot = reviewStore.replaceUserThreads(threads, current.version);
    res.json({ success: true, threadId: req.params.threadId, version: snapshot.version });
  });
  selectedComments.use(reviewErrors(reviewStore, () => true));
  app.use('/api', selectedComments);
  app.use(express.json());
  app.use(express.text());

  /** Parsing can yield while another request changes the browser's current selection. */
  function mutationSelection(req: Request): DiffSelection {
    const selection = mutationSelections.get(req);
    if (!selection) throw new Error('Comment mutation selection was not captured');
    return selection;
  }

  function selectedBody(input: unknown): Record<string, unknown> {
    let body = input;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw Object.assign(new Error('Malformed JSON request'), { code: 'invalid_request' });
      }
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw Object.assign(new Error('Expected a JSON object'), { code: 'invalid_request' });
    return body as Record<string, unknown>;
  }

  function getCommentSelectionFromQuery(query: Record<string, unknown>): DiffSelection {
    const hasBase = typeof query.base === 'string';
    const hasTarget = typeof query.target === 'string';
    const hasBaseMode = typeof query.baseMode === 'string';

    if (!hasBase && !hasTarget && !hasBaseMode) {
      // No selection means the caller is the CLI, which cannot know what the browser is looking at.
      // Pin it to the review difit was launched for, not to the pair a tab loaded last.
      return launchCommentSelection;
    }

    return createDiffSelection(
      hasBase ? (query.base as string) : currentCommentSelection.baseCommitish,
      hasTarget ? (query.target as string) : currentCommentSelection.targetCommitish,
      hasBaseMode
        ? parseBaseMode(query.baseMode)
        : hasBase || hasTarget
          ? undefined
          : currentCommentSelection.baseMode,
    );
  }

  function getOrCreateCommentSession(selection: DiffSelection): CommentSessionState {
    const key = createCommentSessionKey(selection);
    if (key === launchSelectionKey) return reviewStore.snapshot();
    const existing = commentSessions.get(key);
    if (existing) {
      return existing;
    }

    const nextSession: CommentSessionState = {
      threads: [],
      version: 0,
    };
    commentSessions.set(key, nextSession);
    return nextSession;
  }

  app.get('/api/diff', async (req, res) => {
    const ignoreWhitespace = req.query.ignoreWhitespace === 'true';
    const hasBase = typeof req.query.base === 'string';
    const hasTarget = typeof req.query.target === 'string';
    const hasBaseMode = typeof req.query.baseMode === 'string';
    const requestedSelection = createDiffSelection(
      hasBase ? (req.query.base as string) : currentSelection.baseCommitish,
      hasTarget ? (req.query.target as string) : currentSelection.targetCommitish,
      hasBaseMode
        ? parseBaseMode(req.query.baseMode)
        : hasBase || hasTarget
          ? undefined
          : currentSelection.baseMode,
    );
    const shouldIncludeCommentImports =
      initialCommentImports.length > 0 &&
      (Boolean(options.stdinDiff) || diffSelectionsEqual(requestedSelection, initialSelection));

    let responseDiffData = initialDiffData;
    if (!options.stdinDiff) {
      const cacheKey = createDiffCacheKey(requestedSelection, ignoreWhitespace);
      const cached = getCachedDiffResponse(diffDataCache, cacheKey);
      if (cached) {
        responseDiffData = cached;
      } else {
        try {
          responseDiffData = await parser.parseDiff(
            requestedSelection,
            ignoreWhitespace,
            options.contextLines,
          );
        } catch (error) {
          console.error('Error fetching diff:', error);
          res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to fetch diff',
          });
          return;
        }
        setCachedDiffResponse(diffDataCache, cacheKey, responseDiffData);
        generatedStatusCache.clear();
      }
    }

    currentSelection = requestedSelection;

    currentCommentSelection = createResolvedCommentSelection(
      responseDiffData,
      requestedSelection,
      Boolean(options.stdinDiff),
    );

    const baseCommitish =
      responseDiffData.baseCommitish ?? (options.stdinDiff ? 'stdin' : undefined);
    const targetCommitish =
      responseDiffData.targetCommitish ?? (options.stdinDiff ? 'stdin' : undefined);
    const requestedBaseCommitish =
      responseDiffData.requestedBaseCommitish ??
      (requestedSelection.baseCommitish || (options.stdinDiff ? 'stdin' : undefined));
    const requestedTargetCommitish =
      responseDiffData.requestedTargetCommitish ??
      (requestedSelection.targetCommitish || (options.stdinDiff ? 'stdin' : undefined));
    const requestedBaseMode = responseDiffData.requestedBaseMode ?? requestedSelection.baseMode;

    res.json({
      ...responseDiffData,
      ignoreWhitespace,
      openInEditorAvailable: !options.stdinDiff,
      baseCommitish,
      targetCommitish,
      requestedBaseCommitish,
      requestedTargetCommitish,
      requestedBaseMode,
      clearComments: options.clearComments,
      repositoryId,
      commentImports: shouldIncludeCommentImports ? initialCommentImports : undefined,
      commentImportId: shouldIncludeCommentImports ? commentImportId : undefined,
    });
  });

  app.get(/^\/api\/generated-status\/(.*)$/, async (req, res) => {
    if (options.stdinDiff) {
      res.status(400).json({ error: 'Generated status is not available for stdin diff' });
      return;
    }

    try {
      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const normalizedFilepath = filepathResult.path;

      const ref = (req.query.ref as string) || currentSelection.targetCommitish || 'HEAD';
      const cacheKey = `${ref}:${normalizedFilepath}`;
      const now = Date.now();
      const cached = generatedStatusCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        res.json(cached.value);
        return;
      }

      const status = await parser.getGeneratedStatus(normalizedFilepath, ref);
      const response: GeneratedStatusResponse = {
        path: normalizedFilepath,
        ref,
        ...status,
      };
      generatedStatusCache.set(cacheKey, {
        value: response,
        expiresAt: now + GENERATED_STATUS_CACHE_TTL_MS,
      });

      res.json(response);
    } catch (error) {
      console.error('Error fetching generated status:', error);
      res.status(500).json({ error: 'Failed to get generated status' });
    }
  });

  // Get available revisions for revision selector
  app.get('/api/revisions', async (_req, res) => {
    if (options.stdinDiff) {
      res.status(400).json({ error: 'Revision selection not available for stdin diff' });
      return;
    }

    try {
      const { branches, commits, originDefaultBranch, resolvedBase, resolvedTarget } =
        await parser.getRevisionOptions(
          currentSelection.baseCommitish,
          currentSelection.targetCommitish,
        );

      const response: RevisionsResponse = {
        specialOptions: [
          { value: '.', label: 'All Uncommitted Changes' },
          { value: 'staged', label: 'Staging Area' },
          { value: 'working', label: 'Working Directory' },
        ],
        branches,
        commits,
        originDefaultBranch,
        resolvedBase,
        resolvedTarget,
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching revisions:', error);
      res.status(500).json({ error: 'Failed to fetch revisions' });
    }
  });

  app.get(/^\/api\/line-count\/(.*)$/, async (req, res) => {
    try {
      if (options.stdinDiff) {
        res.status(404).json({ error: 'Line count not available for stdin diff' });
        return;
      }

      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const filepath = filepathResult.path;
      const oldRef = req.query.oldRef as string | undefined;
      const oldPathResult = req.query.oldPath
        ? parseRepositoryRelativePath(req.query.oldPath)
        : { ok: true as const, path: filepath };
      if (!oldPathResult.ok) {
        res.status(400).json({ error: oldPathResult.error });
        return;
      }
      const newRef = req.query.newRef as string | undefined;
      const oldPath = oldPathResult.path;

      const result: { oldLineCount?: number; newLineCount?: number } = {};

      if (oldRef) {
        try {
          result.oldLineCount = await parser.getLineCount(oldPath, oldRef);
        } catch {
          result.oldLineCount = 0;
        }
      }
      if (newRef) {
        try {
          result.newLineCount = await parser.getLineCount(filepath, newRef);
        } catch {
          result.newLineCount = 0;
        }
      }

      res.json(result);
    } catch (error) {
      console.error('Error fetching line count:', error);
      res.status(500).json({ error: 'Failed to get line count' });
    }
  });

  app.get(/^\/api\/blob\/(.*)$/, async (req, res) => {
    try {
      // If using stdin diff, blob content is not available
      if (options.stdinDiff) {
        res.status(404).json({ error: 'Blob content not available for stdin diff' });
        return;
      }

      const filepathResult = parseRepositoryRelativePath(req.params[0]);
      if (!filepathResult.ok) {
        res.status(400).json({ error: filepathResult.error });
        return;
      }
      const filepath = filepathResult.path;
      const ref = (req.query.ref as string) || 'HEAD';

      const blob = await parser.getBlobContent(filepath, ref);

      // Determine content type based on file extension
      const ext = getFileExtension(filepath);
      const contentTypes: { [key: string]: string } = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        bmp: 'image/bmp',
        svg: 'image/svg+xml',
        webp: 'image/webp',
        ico: 'image/x-icon',
        tiff: 'image/tiff',
        tif: 'image/tiff',
        avif: 'image/avif',
        heic: 'image/heic',
        heif: 'image/heif',
      };

      const contentType = contentTypes[ext || ''] || 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(blob);
    } catch (error) {
      console.error('Error fetching blob:', error);
      res.status(404).json({ error: 'File not found' });
    }
  });

  function normalizeLineValue(line: unknown): DiffCommentThread['position']['line'] {
    if (Array.isArray(line) && line.length === 2) {
      const start = line[0] as unknown;
      const end = line[1] as unknown;
      if (
        typeof start === 'number' &&
        typeof end === 'number' &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start > 0 &&
        end > 0 &&
        start <= end
      ) {
        return { start, end };
      }
    }

    if (typeof line === 'number' && Number.isInteger(line) && line > 0) {
      return line;
    }

    return 1;
  }

  function normalizeComment(comment: Comment): DiffCommentThread {
    if (typeof comment !== 'object' || comment === null)
      throw Object.assign(new Error('Expected a comment object'), { code: 'invalid_request' });
    const now = new Date().toISOString();
    const timestamp = typeof comment.timestamp === 'string' ? comment.timestamp : now;
    const threadId =
      typeof comment.id === 'string' && comment.id.length > 0
        ? comment.id
        : createHash('sha256').update(JSON.stringify(comment)).digest('hex').slice(0, 12);
    const filePath =
      typeof comment.file === 'string' && comment.file.length > 0 ? comment.file : '<unknown file>';

    return {
      id: threadId,
      filePath,
      createdAt: timestamp,
      updatedAt: timestamp,
      position: {
        side: comment.side ?? 'new',
        line: normalizeLineValue(comment.line),
      },
      codeSnapshot:
        typeof comment.codeContent === 'string'
          ? {
              content: comment.codeContent,
            }
          : undefined,
      messages: [
        {
          id: threadId,
          body: comment.body,
          author: comment.author,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
  }

  function toCommentThread(thread: DiffCommentThread): CommentThread {
    return {
      id: thread.id,
      resolved: thread.resolved ?? false,
      file: thread.filePath,
      line:
        typeof thread.position.line === 'number'
          ? thread.position.line
          : ([thread.position.line.start, thread.position.line.end] as [number, number]),
      side: thread.position.side,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      codeContent: thread.codeSnapshot?.content,
      messages: thread.messages,
    };
  }

  function normalizeThreadPayload(thread: CommentThread | DiffCommentThread): DiffCommentThread {
    if (typeof thread !== 'object' || thread === null)
      throw Object.assign(new Error('Expected a comment thread object'), {
        code: 'invalid_request',
      });
    if ('filePath' in thread && 'position' in thread) {
      return thread;
    }
    if (
      Array.isArray(thread.messages) &&
      thread.messages.some((message) => typeof message !== 'object' || message === null)
    )
      throw Object.assign(new Error('Expected comment message objects'), {
        code: 'invalid_request',
      });

    const threadId =
      typeof thread.id === 'string' && thread.id.length > 0
        ? thread.id
        : createHash('sha256').update(JSON.stringify(thread)).digest('hex').slice(0, 12);
    const now = new Date().toISOString();
    const messages =
      Array.isArray(thread.messages) && thread.messages.length > 0
        ? thread.messages.map((message, index) => ({
            id:
              typeof message.id === 'string' && message.id.length > 0
                ? message.id
                : `${threadId}:${index}`,
            body: message.body,
            author: message.author,
            createdAt: message.createdAt || thread.createdAt || now,
            updatedAt: message.updatedAt || message.createdAt || thread.updatedAt || now,
          }))
        : [
            {
              id: threadId,
              body: '',
              createdAt: thread.createdAt || now,
              updatedAt: thread.updatedAt || thread.createdAt || now,
            },
          ];
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];

    return {
      id: threadId,
      resolved: thread.resolved ?? false,
      filePath:
        typeof thread.file === 'string' && thread.file.length > 0 ? thread.file : '<unknown file>',
      createdAt: thread.createdAt || firstMessage?.createdAt || now,
      updatedAt: thread.updatedAt || lastMessage?.updatedAt || thread.createdAt || now,
      position: {
        side: thread.side ?? 'new',
        line: normalizeLineValue(thread.line),
      },
      codeSnapshot:
        typeof thread.codeContent === 'string'
          ? {
              content: thread.codeContent,
            }
          : undefined,
      messages,
    };
  }

  function parseCommentsPayload(body: unknown): DiffCommentThread[] {
    const payload =
      typeof body === 'string'
        ? (JSON.parse(body) as {
            comments?: Comment[];
            threads?: Array<CommentThread | DiffCommentThread>;
          })
        : (body as {
            comments?: Comment[];
            threads?: Array<CommentThread | DiffCommentThread>;
          });

    if (Array.isArray(payload.threads)) {
      return payload.threads.map(normalizeThreadPayload);
    }

    if (Array.isArray(payload.comments)) {
      return payload.comments.map(normalizeComment);
    }

    return [];
  }

  // Version the client based its push on (omitted by older clients).
  function parseBaseVersion(payload: unknown): number | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = (payload as { baseVersion?: unknown }).baseVersion;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
  }

  function parseCommentImportsPayload(body: unknown): CommentImport[] {
    if (typeof body === 'string') {
      return normalizeCommentImports(JSON.parse(body));
    }

    return normalizeCommentImports(body);
  }

  function updateCommentSession(
    selection: DiffSelection,
    nextThreads: DiffCommentThread[],
  ): boolean {
    if (createCommentSessionKey(selection) === launchSelectionKey)
      throw new Error('Selected review mutations must use the review store');
    const session = getOrCreateCommentSession(selection);
    const previous = JSON.stringify(session.threads);
    const next = JSON.stringify(nextThreads);
    session.threads = nextThreads;

    if (previous === next) {
      return false;
    }

    session.version += 1;
    fileWatcher.broadcast({
      type: 'commentsChanged',
      version: session.version,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  app.post('/api/comments', (req, res) => {
    try {
      const selection = mutationSelection(req);
      const body: unknown =
        typeof req.body === 'string' ? (JSON.parse(req.body) as unknown) : req.body;
      const nextThreads = parseCommentsPayload(body);
      const baseVersion = parseBaseVersion(body);
      const session = getOrCreateCommentSession(selection);

      // Stale baseVersion means another writer (e.g. an agent) changed comments since the
      // client's last read, so merge rather than overwrite. A matching/absent version replaces.
      const isStale = typeof baseVersion === 'number' && baseVersion !== session.version;
      const resolvedThreads = isStale
        ? mergeCommentThreads(session.threads, nextThreads).threads
        : nextThreads;

      updateCommentSession(selection, resolvedThreads);

      res.json({
        success: true,
        merged: isStale,
        version: session.version,
        threads: session.threads,
      });
    } catch (error) {
      console.error('Error parsing comments:', error);
      res.status(400).json({ error: 'Invalid comment data' });
    }
  });

  app.post('/api/comment-imports', (req, res) => {
    try {
      const selection = mutationSelection(req);
      const session = getOrCreateCommentSession(selection);
      const commentImports = parseCommentImportsPayload(req.body);
      const importId = createHash('sha256')
        .update(serializeCommentImports(commentImports))
        .digest('hex');
      const merged = mergeCommentImports(session.threads, commentImports);
      const changed = updateCommentSession(selection, merged.threads);

      res.json({
        success: true,
        changed,
        count: commentImports.length,
        importId,
        warnings: merged.warnings,
      });
    } catch (error) {
      console.error('Error parsing comment imports:', error);
      res.status(400).json({ error: 'Invalid comment import data' });
    }
  });

  app.delete('/api/comments/:threadId', (req, res) => {
    const selection = mutationSelection(req);
    const session = getOrCreateCommentSession(selection);
    const threadId = req.params.threadId;
    const nextThreads = session.threads.filter((thread) => thread.id !== threadId);

    if (nextThreads.length === session.threads.length) {
      res.status(404).json({ error: `Thread not found: ${threadId}` });
      return;
    }

    updateCommentSession(selection, nextThreads);

    res.json({
      success: true,
      threadId,
      version: session.version,
    });
  });

  app.get('/api/comments-json', (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(selection);
    res.json({
      sessionId: reviewStore.snapshot().session.sessionId,
      review:
        createCommentSessionKey(selection) === launchSelectionKey
          ? reviewStore.snapshot().session
          : null,
      selection,
      version: session.version,
      threads: session.threads,
    });
  });

  app.get('/api/comments-output', (req, res) => {
    const selection = getCommentSelectionFromQuery(req.query as Record<string, unknown>);
    const session = getOrCreateCommentSession(selection);
    res.type('text/plain');

    if (session.threads.length > 0) {
      const output = formatCommentsOutput(session.threads.map(toCommentThread));
      res.send(output);
    } else {
      res.send('');
    }
  });

  app.get('/api/user-settings', async (_req, res) => {
    const config = await readUserConfig();
    res.json(config);
  });

  app.put('/api/user-settings', async (req, res) => {
    let patch: Record<string, unknown> | null;
    try {
      const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      patch = parseUserSettingsPatch(body);
    } catch {
      patch = null;
    }

    if (!patch) {
      res.status(400).json({ error: 'Invalid user settings payload' });
      return;
    }

    try {
      const config = await updateUserClientSettings(patch);
      res.json(config);
    } catch (error) {
      console.error('Error saving user settings:', error);
      res.status(500).json({ error: 'Failed to save user settings' });
    }
  });

  app.post('/api/open-in-editor', async (req, res) => {
    if (options.stdinDiff) {
      res.status(400).json({ error: 'Open in editor is not available for stdin diff' });
      return;
    }

    // The spawn spec comes from the request body, so anything that can reach this
    // port runs code as our uid. Refuse outright when we are reachable off-host.
    if (!serverBoundToLoopback) {
      res.status(403).json({
        error: 'Open in editor is disabled when the server is not bound to loopback',
      });
      return;
    }

    // Checked before the request is parsed: the old check consulted the caller's
    // own `editor.id` first, so a body naming any other editor bypassed it.
    // `resolveEnvEditor` is the single place that encodes DIFIT_EDITOR taking
    // priority over EDITOR — reused below when resolving the editor id — so
    // this guard cannot drift out of step with that resolution.
    const envEditor = resolveEnvEditor();
    if (envEditor.source && envEditor.id?.toLowerCase() === NONE_EDITOR_ID) {
      res.status(403).json({ error: `Open in editor is disabled by ${envEditor.source}=none` });
      return;
    }

    const { filePath, line, editor } = (req.body ?? {}) as {
      filePath?: unknown;
      line?: unknown;
      editor?: unknown;
    };

    if (typeof filePath !== 'string') {
      res.status(400).json({ error: 'Invalid request payload' });
      return;
    }

    const filepathResult = parseRepositoryRelativePath(filePath);
    if (!filepathResult.ok) {
      res.status(400).json({ error: filepathResult.error });
      return;
    }
    const resolvedPath = resolve(repositoryPath, filepathResult.path);

    const editorRequest = parseEditorRequest(editor);
    const editorId = editorRequest.id ?? envEditor.id;

    if (editorId?.toLowerCase() === NONE_EDITOR_ID) {
      res.status(403).json({ error: 'Open in editor is disabled' });
      return;
    }

    // The browser always sends command + argsTemplate in the body, so we use
    // those directly. We only fall back to the preset table when neither is
    // provided (for example, when DIFIT_EDITOR is set and there's no body).
    let command: string;
    let argsTemplate: string;
    if (editorRequest.command !== undefined || editorRequest.argsTemplate !== undefined) {
      command = (editorRequest.command ?? '').trim();
      argsTemplate = (editorRequest.argsTemplate ?? '').trim();
    } else {
      const preset = resolveEditorOption(editorId);
      command = preset.command;
      argsTemplate = preset.argsTemplate;
    }

    if (!command || !argsTemplate) {
      const isCustom = editorId?.toLowerCase() === CUSTOM_EDITOR_ID;
      res.status(400).json({
        error: isCustom
          ? 'Custom editor is not configured. Set a command and arguments in Settings > System.'
          : 'Open in editor is not configured',
      });
      return;
    }

    const lineNumber = (() => {
      const parsed = Number.parseInt(String(line ?? ''), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    })();

    const spawnSpec = buildEditorSpawnSpec({
      command,
      argsTemplate,
      filePath: resolvedPath,
      lineNumber,
    });

    if (!spawnSpec) {
      res.status(500).json({ error: 'Invalid editor configuration' });
      return;
    }

    const launched = await new Promise<boolean>((resolvePromise) => {
      const child = spawn(spawnSpec.command, [...spawnSpec.args], {
        stdio: 'ignore',
        detached: true,
      });
      child.once('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== 'ENOENT') {
          console.error('Failed to launch editor CLI:', error);
        }
        resolvePromise(false);
      });
      child.once('spawn', () => {
        child.unref();
        resolvePromise(true);
      });
    });

    if (!launched) {
      res.status(500).json({
        error: `Failed to launch editor: command "${spawnSpec.command}" is not available on PATH`,
      });
      return;
    }

    res.json({ success: true });
  });

  // Print the review's comments as the server shuts down, for a person watching the terminal.
  function outputFinalComments(): void {
    const session = getOrCreateCommentSession(currentCommentSelection);
    if (session.threads.length > 0) {
      console.log(formatCommentsOutput(session.threads.map(toCommentThread)));
    }
  }

  // SSE endpoint for file watching
  app.get('/api/watch', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    fileWatcher.addClient(res);
    watchResponses.add(res);

    req.on('close', () => {
      fileWatcher.removeClient(res);
      watchResponses.delete(res);
    });
  });

  // SSE endpoint to detect when tab is closed
  app.get('/api/heartbeat', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial heartbeat
    res.write('data: connected\n\n');

    // Send heartbeat every 5 seconds
    const heartbeatInterval = setInterval(() => {
      res.write('data: heartbeat\n\n');
    }, 5000);

    heartbeatResponses.add(res);
    lifecycle.onConnect(new Date());
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    req.on('close', () => {
      clearInterval(heartbeatInterval);
      heartbeatResponses.delete(res);
      if (shutdownClaimed) return;
      lifecycle.onDisconnect(new Date());

      if (lifecycle.stateAt(new Date()).clients > 0) {
        return;
      }

      // Re-ask the lifecycle once the grace period has had time to elapse, rather
      // than assuming this close was the last one. A reload passes through zero.
      /** Timer delivery can precede the wall-clock deadline, so preserve the remaining grace. */
      const checkIdle = (): void => {
        idleTimer = null;
        if (shutdownClaimed) return;
        const now = new Date();
        const state = lifecycle.stateAt(now);
        if (!state.terminal) {
          if (state.clients === 0 && state.idleSince !== null) {
            const remainingMs = state.idleSince.getTime() + idleGraceMs - now.getTime();
            idleTimer = setTimeout(checkIdle, remainingMs).unref();
          }
          return;
        }

        if (shutdownClaimed) return;

        if (!backgroundReview && options.keepAlive) {
          // A foreground --keep-alive exists so the review can go on over later rounds, so an idle
          // browser must not latch completion: input stays open and the process stays up.
          logHuman('Review went idle, but the server is staying alive (--keep-alive)');
          logHuman('Press Ctrl+C to stop the server');
          return;
        }

        reviewStore.finish('browser_idle');

        if (backgroundReview) {
          return;
        }

        logHuman('Review went idle, shutting down server...');
        startShutdown();
      };
      idleTimer = setTimeout(checkIdle, idleGraceMs).unref();
    });
  });

  // Always runs in production mode when distributed as a CLI tool
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV !== 'development';

  if (isProduction) {
    // Find client files relative to the CLI executable location
    const distPath = join(__dirname, '..', 'client');
    app.use(express.static(distPath));
  } else {
    app.get('/', (_req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>difit - Dev Mode</title>
          </head>
          <body>
            <div id="root"></div>
            <script>
              console.log('difit development mode');
              console.log('Diff data available at /api/diff');
            </script>
          </body>
        </html>
      `);
    });
  }

  const preferredPort = effectivePreferredPort(options.preferredPort);
  const listener = await startServerWithFallback(
    app,
    preferredPort,
    options.host || 'localhost',
    options.maxPort ?? preferredPort + 99,
    options.strictPort ?? false,
    logHuman,
  );
  const { port, url } = listener;
  server = listener.server;
  serverBoundToLoopback = isLoopbackAddress(server.address());

  publicUrl = resolvePublicUrl(options.publicUrl, port, url);
  reviewStore.setConnection({
    publicUrl,
    apiUrl: listenerApiUrl(server.address()),
    port,
    pid: process.pid,
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);

  // One deadline, owned here. A background review then follows completion into its cleanup; a
  // foreground one ends the process, unless the user explicitly asked it to stay.
  if (reviewTimeoutMs !== null) {
    reviewTimeoutTimer = setTimeout(() => {
      reviewStore.finish('review_timeout');
      if (backgroundReview) return;
      if (options.keepAlive) {
        // Keep-alive keeps the server reachable, but the review is over: the page can no longer be
        // commented on, and saying nothing would leave that looking like a bug.
        logHuman('Review timed out. The server is staying up (--keep-alive), but input is closed.');
        logHuman('Press Ctrl+C to stop the server');
        return;
      }
      logHuman('Review timed out, shutting down server...');
      startShutdown();
    }, reviewTimeoutMs).unref();
  }

  // Guard against lifecycle timers and process handlers outliving this server.
  server.on('close', () => {
    clearLifecycleTimers();
    unsubscribeBroadcast();
    unsubscribeCleanupScheduler();
    removeSignalHandlers();
  });

  // Security warning for non-localhost binding
  if (!serverBoundToLoopback) {
    console.warn('\n⚠️  WARNING: Server is accessible from external network!');
    console.warn(`   Binding to: ${options.host}:${port}`);
    console.warn('   Open in editor is disabled while bound off-loopback.');
    console.warn('   Make sure this is intended and your network is secure.\n');
  }

  // Start file watcher
  if (options.diffMode) {
    try {
      await fileWatcher.start(options.diffMode, repositoryPath, 300, invalidateCache, logHuman);
    } catch (error) {
      console.warn('⚠️  File watcher failed to start:', error);
      console.warn('   Continuing without file watching...');
    }
  }

  // Check if diff is empty and skip browser opening
  if (initialDiffData.isEmpty) {
    // Don't open browser if no differences found
  } else if (options.openBrowser) {
    try {
      await open(url);
    } catch {
      console.warn('Failed to open browser automatically');
    }
  }

  return {
    port,
    url,
    isEmpty: initialDiffData.isEmpty || false,
    server,
    getReviewSnapshot: () => reviewStore.snapshot(),
    startShutdown,
  };
}

async function startServerWithFallback(
  app: Express,
  preferredPort: number,
  host: string,
  maxPort: number,
  strictPort: boolean,
  log: (message: string) => void,
  startPort: number = preferredPort,
): Promise<{ port: number; url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    // express's listen() method uses listen() method in node:net Server instance internally
    // https://expressjs.com/en/5x/api.html#app.listen
    // so, an error will be an instance of NodeJS.ErrnoException
    const server = app.listen(preferredPort, host, (err: NodeJS.ErrnoException | undefined) => {
      const displayHost = host === '0.0.0.0' ? 'localhost' : host;
      const url = `http://${displayHost}:${preferredPort}`;
      if (!err) {
        resolve({ port: preferredPort, url, server });
        return;
      }

      // Handling errors when failed to launch a server
      switch (err.code) {
        // Try another port until it succeeds
        case 'EADDRINUSE': {
          if (strictPort) {
            reject(new Error(`Port ${preferredPort} is already in use`));
            return;
          }

          if (preferredPort >= maxPort) {
            reject(
              new Error(
                `No free port in range ${startPort}-${maxPort}. ` +
                  'Free a port or widen --max-port.',
              ),
            );
            return;
          }

          log(`Port ${preferredPort} is busy, trying ${preferredPort + 1}...`);
          return startServerWithFallback(
            app,
            preferredPort + 1,
            host,
            maxPort,
            strictPort,
            log,
            startPort,
          )
            .then(({ port, url, server }) => {
              resolve({ port, url, server });
            })
            .catch(reject);
        }
        // Unexpected error
        default: {
          reject(new Error(`Failed to launch a server: ${err.message}`));
        }
      }
    });
  });
}
