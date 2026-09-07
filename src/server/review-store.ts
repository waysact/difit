import { isDeepStrictEqual } from 'node:util';

import type { DiffCommentMessage, DiffCommentThread } from '../types/diff.js';
import type {
  EventPage,
  ReplyInput,
  ReplyResult,
  ReviewActor,
  ReviewEvent,
  ReviewEventType,
  ReviewInfo,
  ReviewLimits,
  ReviewReason,
  ReviewSelection,
  ReviewSnapshot,
  ReviewStore,
  ReviewStoreOptions,
  ReviewThread,
} from '../types/review.js';
import { buildReviewSnapshot } from './review-snapshot.js';

interface PendingEvent {
  type: ReviewEventType;
  threadId?: string;
  messageId?: string;
}
type StoreErrorCode =
  | 'invalid_request'
  | 'invalid_cursor'
  | 'version_required'
  | 'version_conflict'
  | 'thread_not_found'
  | 'message_id_conflict'
  | 'reply_deleted'
  | 'review_finished'
  | 'session_stopping';

/** Lets transports translate failures without parsing human-readable text. */
class ReviewStoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewStoreError';
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function requireValid(valid: boolean): asserts valid {
  if (!valid) {
    throw new ReviewStoreError('invalid_request', 'Invalid review mutation');
  }
}

function requireVersion(expectedVersion: number): void {
  if (expectedVersion === undefined) {
    throw new ReviewStoreError('version_required', 'A comment version is required');
  }
  requireValid(natural(expectedVersion));
}

/** Validate the full collection before cloning or committing any part of it. */
function normalizeThreads(input: DiffCommentThread[]): ReviewThread[] {
  requireValid(Array.isArray(input));
  const threadIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const thread of input) {
    requireValid(record(thread) && nonempty(thread.id) && !threadIds.has(thread.id));
    threadIds.add(thread.id);
    requireValid(
      nonempty(thread.filePath) &&
        typeof thread.createdAt === 'string' &&
        typeof thread.updatedAt === 'string',
    );
    requireValid(thread.resolved === undefined || typeof thread.resolved === 'boolean');
    requireValid(
      record(thread.position) && (thread.position.side === 'old' || thread.position.side === 'new'),
    );
    const line = thread.position.line;
    requireValid(
      (natural(line) && line > 0) ||
        (record(line) &&
          natural(line.start) &&
          line.start > 0 &&
          natural(line.end) &&
          line.end >= line.start),
    );
    if (thread.codeSnapshot !== undefined) {
      requireValid(
        record(thread.codeSnapshot) &&
          typeof thread.codeSnapshot.content === 'string' &&
          (thread.codeSnapshot.language === undefined ||
            typeof thread.codeSnapshot.language === 'string'),
      );
    }
    requireValid(Array.isArray(thread.messages));
    for (const message of thread.messages) {
      requireValid(record(message) && nonempty(message.id) && !messageIds.has(message.id));
      messageIds.add(message.id);
      requireValid(
        typeof message.body === 'string' &&
          typeof message.createdAt === 'string' &&
          typeof message.updatedAt === 'string' &&
          (message.author === undefined || typeof message.author === 'string'),
      );
    }
  }
  return structuredClone(input).map((thread) => {
    if (thread.codeSnapshot === undefined) delete thread.codeSnapshot;
    else if (thread.codeSnapshot.language === undefined) delete thread.codeSnapshot.language;
    for (const message of thread.messages) {
      if (message.author === undefined) delete message.author;
    }
    return { ...thread, resolved: thread.resolved ?? false };
  });
}

/** Stable IDs determine journal ordering, independent of a browser's array order. */
function collectionEvents(before: ReviewThread[], after: ReviewThread[]): PendingEvent[] {
  const previous = new Map(before.map((thread) => [thread.id, thread]));
  const next = new Map(after.map((thread) => [thread.id, thread]));
  const previousOrder = before.filter((thread) => next.has(thread.id)).map((thread) => thread.id);
  const nextOrder = after.filter((thread) => previous.has(thread.id)).map((thread) => thread.id);
  const events: PendingEvent[] = [];
  for (const threadId of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const oldThread = previous.get(threadId);
    const newThread = next.get(threadId);
    if (!oldThread) {
      events.push({ type: 'thread.created', threadId });
    }
    const oldMessages = new Map(oldThread?.messages.map((message) => [message.id, message]));
    const newMessages = new Map(newThread?.messages.map((message) => [message.id, message]));
    const threadEvents: PendingEvent[] = [];
    for (const messageId of [...new Set([...oldMessages.keys(), ...newMessages.keys()])].sort()) {
      const oldMessage = oldMessages.get(messageId);
      const newMessage = newMessages.get(messageId);
      if (!oldMessage) {
        threadEvents.push({ type: 'message.created', threadId, messageId });
      } else if (!newMessage) {
        threadEvents.push({ type: 'message.deleted', threadId, messageId });
      } else if (!isDeepStrictEqual(oldMessage, newMessage)) {
        threadEvents.push({ type: 'message.updated', threadId, messageId });
      }
    }
    if (oldThread && newThread) {
      const oldMetadata = {
        filePath: oldThread.filePath,
        position: oldThread.position,
        codeSnapshot: oldThread.codeSnapshot,
        createdAt: oldThread.createdAt,
      };
      const newMetadata = {
        filePath: newThread.filePath,
        position: newThread.position,
        codeSnapshot: newThread.codeSnapshot,
        createdAt: newThread.createdAt,
      };
      const resolutionChanged = oldThread.resolved !== newThread.resolved;
      const previousMessageOrder = oldThread.messages
        .filter((message) => newMessages.has(message.id))
        .map((message) => message.id);
      const nextMessageOrder = newThread.messages
        .filter((message) => oldMessages.has(message.id))
        .map((message) => message.id);
      const orderChanged =
        previousOrder.indexOf(threadId) !== nextOrder.indexOf(threadId) ||
        !isDeepStrictEqual(previousMessageOrder, nextMessageOrder);
      if (
        orderChanged ||
        !isDeepStrictEqual(oldMetadata, newMetadata) ||
        (threadEvents.length === 0 &&
          !resolutionChanged &&
          oldThread.updatedAt !== newThread.updatedAt)
      ) {
        threadEvents.push({ type: 'thread.updated', threadId });
      }
      if (resolutionChanged) {
        threadEvents.push({
          type: newThread.resolved ? 'thread.resolved' : 'thread.reopened',
          threadId,
        });
      }
    }
    events.push(...threadEvents);
    if (!newThread) {
      events.push({ type: 'thread.deleted', threadId });
    }
  }
  return events;
}

/** Owns synchronous review transitions; subscribers see only fully committed state. */
export function createReviewStore(options: ReviewStoreOptions): ReviewStore {
  const { now: clock, autoCleanup = true } = options;
  let threads: ReviewThread[] = [];
  let version = 0;
  let stopping = false;
  let stoppedSnapshot: ReviewSnapshot | undefined;
  const listeners = new Set<() => void>();
  const events: ReviewEvent[] = [];
  const replies = new Map<string, { threadId: string; body: string; deleted: boolean }>();
  const selection: ReviewSelection = structuredClone(options.selection);
  const limits: ReviewLimits = structuredClone(options.limits);
  const session: ReviewInfo = {
    sessionId: options.sessionId,
    selectionKey: options.selectionKey,
    selection,
    limits,
    publicUrl: '',
    apiUrl: '',
    port: 0,
    pid: 0,
    state: 'active',
    reason: null,
    cursor: 0,
    finishedCursor: null,
    finishedAt: null,
    cleanupAt: null,
  };

  const snapshot = (): ReviewSnapshot =>
    buildReviewSnapshot({ session, threads, version, cursor: session.cursor });
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const assertWritable = (): void => {
    if (stopping) {
      throw new ReviewStoreError('session_stopping', 'Review is stopping');
    }
  };
  const assertVersion = (expectedVersion: number): void => {
    requireVersion(expectedVersion);
    if (expectedVersion !== version) {
      throw new ReviewStoreError('version_conflict', 'Comment version has changed');
    }
  };
  const getThread = (threadId: string): ReviewThread => {
    requireValid(nonempty(threadId));
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      throw new ReviewStoreError('thread_not_found', 'Review thread does not exist');
    }
    return thread;
  };
  const append = (pending: PendingEvent[], actor: ReviewActor): void => {
    for (const event of pending) {
      session.cursor += 1;
      events.push({ ...event, actor, sessionId: session.sessionId, cursor: session.cursor });
    }
  };
  const commit = (next: ReviewThread[], actor: ReviewActor): ReviewSnapshot => {
    const pending = collectionEvents(threads, next);
    if (pending.length === 0) {
      return snapshot();
    }
    threads = next;
    version += 1;
    append(pending, actor);
    for (const [id, reservation] of replies) {
      if (
        !threads.some(
          (thread) =>
            thread.id === reservation.threadId &&
            thread.messages.some((message) => message.id === id),
        )
      ) {
        reservation.deleted = true;
      }
    }
    const result = snapshot();
    notify();
    return result;
  };

  /** The first completion owns the cutoff, even if agent work continues afterward. */
  const complete = (reason: ReviewReason): boolean => {
    if (session.state === 'finished') {
      return false;
    }
    const now = clock();
    session.state = 'finished';
    session.reason = reason;
    session.finishedAt = now.toISOString();
    session.cleanupAt = !autoCleanup
      ? null
      : new Date(now.getTime() + session.limits.cleanupGraceMs).toISOString();
    append([{ type: 'review.finished' }], 'system');
    session.finishedCursor = session.cursor;
    return true;
  };

  commit(normalizeThreads(options.initialThreads), 'user');

  return {
    snapshot,
    checkUserVersion(expectedVersion) {
      assertWritable();
      if (session.state === 'finished')
        throw new ReviewStoreError('review_finished', 'Review input is closed');
      if (expectedVersion === undefined)
        throw new ReviewStoreError(
          'version_required',
          'Read /api/comments-json and send the current comment version',
        );
      requireValid(natural(expectedVersion));
      assertVersion(expectedVersion as number);
      return snapshot();
    },
    setConnection(info) {
      assertWritable();
      requireValid(
        nonempty(info.publicUrl) &&
          nonempty(info.apiUrl) &&
          natural(info.port) &&
          info.port > 0 &&
          info.port <= 65535 &&
          natural(info.pid) &&
          info.pid > 0,
      );
      session.publicUrl = info.publicUrl;
      session.apiUrl = info.apiUrl;
      session.port = info.port;
      session.pid = info.pid;
    },
    page(after): EventPage {
      if (!natural(after) || after > session.cursor) {
        throw new ReviewStoreError(
          'invalid_cursor',
          'Cursor must identify an existing journal position',
        );
      }
      const pageEvents = events.slice(after, after + 100);
      const nextCursor = pageEvents.at(-1)?.cursor ?? after;
      return structuredClone({
        session,
        events: pageEvents,
        nextCursor,
        hasMore: nextCursor < session.cursor,
      });
    },
    replaceUserThreads(input, expectedVersion) {
      assertWritable();
      if (session.state === 'finished') {
        throw new ReviewStoreError('review_finished', 'The user review has finished');
      }
      assertVersion(expectedVersion);
      return commit(normalizeThreads(input), 'user');
    },
    reply(threadId: string, input: ReplyInput): ReplyResult {
      assertWritable();
      requireValid(
        nonempty(threadId) && record(input) && nonempty(input.id) && nonempty(input.body),
      );
      requireVersion(input.expectedVersion);
      const reservation = replies.get(input.id);
      if (reservation) {
        if (reservation.threadId !== threadId || reservation.body !== input.body) {
          throw new ReviewStoreError(
            'message_id_conflict',
            'Reply ID was accepted with different content',
          );
        }
        const message = threads
          .find((thread) => thread.id === threadId)
          ?.messages.find((candidate) => candidate.id === input.id);
        if (reservation.deleted || !message) {
          throw new ReviewStoreError('reply_deleted', 'The accepted reply was deleted');
        }
        return { snapshot: snapshot(), message: structuredClone(message), replayed: true };
      }
      assertVersion(input.expectedVersion);
      const thread = getThread(threadId);
      if (
        threads.some((candidate) => candidate.messages.some((message) => message.id === input.id))
      ) {
        throw new ReviewStoreError('message_id_conflict', 'Message ID already exists');
      }
      const timestamp = clock().toISOString();
      const message: DiffCommentMessage = {
        id: input.id,
        body: input.body,
        author: 'Agent',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next = threads.map((candidate) =>
        candidate.id === threadId
          ? { ...thread, updatedAt: timestamp, messages: [...thread.messages, message] }
          : candidate,
      );
      replies.set(input.id, { threadId, body: input.body, deleted: false });
      const result = commit(next, 'agent');
      return { snapshot: result, message: structuredClone(message), replayed: false };
    },
    setResolved(threadId, resolved, expectedVersion) {
      assertWritable();
      requireValid(typeof resolved === 'boolean');
      assertVersion(expectedVersion);
      const thread = getThread(threadId);
      if (thread.resolved === resolved) {
        return snapshot();
      }
      const timestamp = clock().toISOString();
      return commit(
        threads.map((candidate) =>
          candidate.id === threadId ? { ...thread, resolved, updatedAt: timestamp } : candidate,
        ),
        'agent',
      );
    },
    finish(reason) {
      assertWritable();
      requireValid(
        reason === 'browser_idle' || reason === 'review_timeout' || reason === 'agent_stop',
      );
      const changed = complete(reason);
      const result = snapshot();
      if (changed) {
        notify();
      }
      return result;
    },
    beginStop() {
      if (stoppedSnapshot) {
        return structuredClone(stoppedSnapshot);
      }
      stopping = true;
      const changed = complete('agent_stop');
      stoppedSnapshot = snapshot();
      if (changed) {
        notify();
      }
      return structuredClone(stoppedSnapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
