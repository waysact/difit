import type { DiffCommentMessage } from '../../types/diff';
import type { ReviewThread } from '../../types/review';

/** A locally queued intent that can be replayed against a refreshed review snapshot. */
export type PendingReviewEdit =
  | { kind: 'createThread'; thread: ReviewThread }
  | { kind: 'reply'; threadId: string; message: DiffCommentMessage }
  | {
      kind: 'editMessage';
      threadId: string;
      before: DiffCommentMessage;
      body: string;
      updatedAt: string;
    }
  | { kind: 'deleteMessage'; threadId: string; before: DiffCommentMessage }
  | { kind: 'deleteThread'; before: ReviewThread }
  | {
      kind: 'setResolved';
      threadId: string;
      before: boolean;
      resolved: boolean;
      updatedAt: string;
    };

type ApplyReviewEditsResult =
  | { ok: true; threads: ReviewThread[] }
  | { ok: false; conflictIndex: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isMessage(value: unknown): value is DiffCommentMessage {
  return (
    isRecord(value) &&
    isString(value['id']) &&
    isString(value['body']) &&
    isOptionalString(value['author']) &&
    isString(value['createdAt']) &&
    isString(value['updatedAt'])
  );
}

function isThread(value: unknown): value is ReviewThread {
  if (!isRecord(value)) return false;
  const position = value['position'];
  if (!isRecord(position)) return false;
  const line = position['line'];
  const codeSnapshot = value['codeSnapshot'];
  return (
    isString(value['id']) &&
    isString(value['filePath']) &&
    typeof value['resolved'] === 'boolean' &&
    isString(value['createdAt']) &&
    isString(value['updatedAt']) &&
    (position['side'] === 'old' || position['side'] === 'new') &&
    (typeof line === 'number' ||
      (isRecord(line) && typeof line['start'] === 'number' && typeof line['end'] === 'number')) &&
    (codeSnapshot === undefined ||
      (isRecord(codeSnapshot) &&
        isString(codeSnapshot['content']) &&
        isOptionalString(codeSnapshot['language']))) &&
    Array.isArray(value['messages']) &&
    value['messages'].every(isMessage)
  );
}

/**
 * Check the fields each kind is replayed through, not just the tag. A stored draft outlives the
 * build that wrote it, so an entry can arrive with a known kind and none of the shape the replay
 * reads; this is the one predicate both the store and the replay trust.
 */
export function isPendingReviewEdit(value: unknown): value is PendingReviewEdit {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'createThread':
      return isThread(value['thread']);
    case 'reply':
      return isString(value['threadId']) && isMessage(value['message']);
    case 'editMessage':
      return (
        isString(value['threadId']) &&
        isMessage(value['before']) &&
        isString(value['body']) &&
        isString(value['updatedAt'])
      );
    case 'deleteMessage':
      return isString(value['threadId']) && isMessage(value['before']);
    case 'deleteThread':
      return isThread(value['before']);
    case 'setResolved':
      return (
        isString(value['threadId']) &&
        typeof value['before'] === 'boolean' &&
        typeof value['resolved'] === 'boolean' &&
        isString(value['updatedAt'])
      );
    default:
      return false;
  }
}

/**
 * Clone review data so a failed replay cannot mutate the acknowledged snapshot. An absent optional
 * property stays absent: these values are compared against JSON that came back from the server,
 * which never carries a key whose value is undefined.
 */
function cloneThreads(threads: ReviewThread[]): ReviewThread[] {
  return threads.map((thread) => ({
    ...thread,
    position:
      typeof thread.position.line === 'number'
        ? { ...thread.position }
        : { ...thread.position, line: { ...thread.position.line } },
    ...(thread.codeSnapshot ? { codeSnapshot: { ...thread.codeSnapshot } } : {}),
    messages: thread.messages.map((message) => ({ ...message })),
  }));
}

/**
 * Compare JSON-shaped review values without depending on their property insertion order. A key
 * whose value is undefined counts as absent, because one side of every comparison here has been
 * through JSON and the other has not: treating them as different shapes would report a conflict
 * for a thread nobody touched.
 */
function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => valuesEqual(item, right[index]))
    );
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const definedKeys = (record: Record<string, unknown>): string[] =>
    Object.keys(record).filter((key) => record[key] !== undefined);
  const leftKeys = definedKeys(leftRecord);
  return (
    leftKeys.length === definedKeys(rightRecord).length &&
    leftKeys.every((key) => valuesEqual(leftRecord[key], rightRecord[key]))
  );
}

/** Reject an ambiguous snapshot before an ID lookup can select an arbitrary object. */
function hasConflictingDuplicateIds(threads: ReviewThread[]): boolean {
  const threadIds = new Map<string, ReviewThread>();
  const messageIds = new Map<string, DiffCommentMessage>();

  for (const thread of threads) {
    const matchingThread = threadIds.get(thread.id);
    if (matchingThread && !valuesEqual(matchingThread, thread)) return true;
    threadIds.set(thread.id, thread);

    for (const message of thread.messages) {
      const matchingMessage = messageIds.get(message.id);
      if (matchingMessage && !valuesEqual(matchingMessage, message)) return true;
      messageIds.set(message.id, message);
    }
  }

  return false;
}

/**
 * Locate a target by its stable review thread identifier, returning the index alongside the thread
 * so a caller can both compare the prior value and replace it in place.
 */
function findThread(
  threads: ReviewThread[],
  threadId: string,
): { index: number; thread: ReviewThread } | null {
  const index = threads.findIndex((candidate) => candidate.id === threadId);
  const thread = threads[index];
  return thread ? { index, thread } : null;
}

/** Locate a message within a thread, keeping its index for in-place replacement. */
function findMessage(
  thread: ReviewThread,
  messageId: string,
): { index: number; message: DiffCommentMessage } | null {
  const index = thread.messages.findIndex((candidate) => candidate.id === messageId);
  const message = thread.messages[index];
  return message ? { index, message } : null;
}

/** Apply queued browser intents to a server snapshot without overwriting unrelated review updates. */
export function applyReviewEdits(
  current: ReviewThread[],
  edits: PendingReviewEdit[],
): ApplyReviewEditsResult {
  const threads = cloneThreads(current);

  for (const [conflictIndex, edit] of edits.entries()) {
    // An entry this build cannot replay is a conflict at its index, not an exception: this runs
    // inside the render that projects the queue, and the conflict path already offers a discard.
    if (!isPendingReviewEdit(edit)) return { ok: false, conflictIndex };
    if (hasConflictingDuplicateIds(threads)) return { ok: false, conflictIndex };

    switch (edit.kind) {
      case 'createThread': {
        const existing = findThread(threads, edit.thread.id);
        if (existing) {
          // The creation may already have landed and then been replied to, so the thread is only a
          // conflict if the messages this edit created are no longer there as written.
          const survived = edit.thread.messages.every((created) => {
            const current = findMessage(existing.thread, created.id);
            return current !== null && valuesEqual(current.message, created);
          });
          if (!survived) return { ok: false, conflictIndex };
          break;
        }
        threads.push(...cloneThreads([edit.thread]));
        break;
      }

      case 'reply': {
        const target = findThread(threads, edit.threadId);
        if (!target) return { ok: false, conflictIndex };
        const existing = findMessage(target.thread, edit.message.id);
        if (existing) {
          if (!valuesEqual(existing.message, edit.message)) return { ok: false, conflictIndex };
          break;
        }
        threads[target.index] = {
          ...target.thread,
          updatedAt: edit.message.updatedAt,
          messages: [...target.thread.messages, { ...edit.message }],
        };
        break;
      }

      case 'editMessage': {
        const target = findThread(threads, edit.threadId);
        if (!target) return { ok: false, conflictIndex };
        const existing = findMessage(target.thread, edit.before.id);
        if (!existing) return { ok: false, conflictIndex };
        if (!valuesEqual(existing.message, edit.before)) {
          if (existing.message.body !== edit.body) return { ok: false, conflictIndex };
          break;
        }
        const messages = [...target.thread.messages];
        messages[existing.index] = {
          ...existing.message,
          body: edit.body,
          updatedAt: edit.updatedAt,
        };
        threads[target.index] = { ...target.thread, updatedAt: edit.updatedAt, messages };
        break;
      }

      case 'deleteMessage': {
        const target = findThread(threads, edit.threadId);
        if (!target) break;
        const existing = findMessage(target.thread, edit.before.id);
        if (!existing) break;
        if (!valuesEqual(existing.message, edit.before)) return { ok: false, conflictIndex };
        threads[target.index] = {
          ...target.thread,
          messages: target.thread.messages.filter((message) => message.id !== edit.before.id),
        };
        break;
      }

      case 'deleteThread': {
        const target = findThread(threads, edit.before.id);
        if (!target) break;
        if (!valuesEqual(target.thread, edit.before)) return { ok: false, conflictIndex };
        threads.splice(target.index, 1);
        break;
      }

      case 'setResolved': {
        const target = findThread(threads, edit.threadId);
        if (!target) return { ok: false, conflictIndex };
        if (target.thread.resolved !== edit.before) {
          if (target.thread.resolved !== edit.resolved) return { ok: false, conflictIndex };
          break;
        }
        threads[target.index] = {
          ...target.thread,
          resolved: edit.resolved,
          updatedAt: edit.updatedAt,
        };
        break;
      }
    }
  }

  if (hasConflictingDuplicateIds(threads)) return { ok: false, conflictIndex: edits.length };
  return { ok: true, threads };
}
