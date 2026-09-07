import type { BaseMode, DiffCommentMessage, DiffCommentThread } from './diff.js';

export type ReviewThread = DiffCommentThread & { resolved: boolean };
export type ReviewReason = 'browser_idle' | 'review_timeout' | 'agent_stop';
export type ReviewActor = 'user' | 'agent' | 'system';
export type ReviewEventType =
  | 'thread.created'
  | 'thread.updated'
  | 'thread.deleted'
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'thread.resolved'
  | 'thread.reopened'
  | 'review.finished';

export interface ReviewLimits {
  idleGraceMs: number;
  /** Null when no deadline is armed, which is a foreground launch without `--timeout`. */
  timeoutMs: number | null;
  cleanupGraceMs: number;
}

export interface ReviewSelection {
  requestedBase: string;
  requestedTarget: string;
  resolvedBase: string;
  resolvedTarget: string;
  baseMode: BaseMode;
}

export interface ReviewInfo {
  sessionId: string;
  selectionKey: string;
  selection: ReviewSelection;
  publicUrl: string;
  apiUrl: string;
  port: number;
  pid: number;
  state: 'active' | 'finished';
  reason: ReviewReason | null;
  cursor: number;
  finishedCursor: number | null;
  finishedAt: string | null;
  cleanupAt: string | null;
  limits: ReviewLimits;
}

export interface ReviewSnapshot {
  session: ReviewInfo;
  threads: ReviewThread[];
  version: number;
  cursor: number;
}

export interface ReviewEvent {
  cursor: number;
  sessionId: string;
  type: ReviewEventType;
  actor: ReviewActor;
  threadId?: string;
  messageId?: string;
}

export interface EventPage {
  session: ReviewInfo;
  events: ReviewEvent[];
  nextCursor: number;
  hasMore: boolean;
}

export interface ReviewStoreOptions {
  sessionId: string;
  selectionKey: string;
  initialThreads: DiffCommentThread[];
  selection: ReviewSelection;
  limits: ReviewLimits;
  now: () => Date;
  autoCleanup?: boolean;
}

export interface ReplyInput {
  id: string;
  body: string;
  expectedVersion: number;
}

export interface ReplyResult {
  snapshot: ReviewSnapshot;
  message: DiffCommentMessage;
  replayed: boolean;
}

export interface ReviewStore {
  setConnection(info: { publicUrl: string; apiUrl: string; port: number; pid: number }): void;
  snapshot(): ReviewSnapshot;
  page(after: number): EventPage;
  replaceUserThreads(threads: DiffCommentThread[], expectedVersion: number): ReviewSnapshot;
  /** Check the user input boundary before computing a prospective import or deletion. */
  checkUserVersion(expectedVersion: unknown): ReviewSnapshot;
  reply(threadId: string, input: ReplyInput): ReplyResult;
  setResolved(threadId: string, resolved: boolean, expectedVersion: number): ReviewSnapshot;
  finish(reason: ReviewReason): ReviewSnapshot;
  beginStop(): ReviewSnapshot;
  subscribe(listener: () => void): () => void;
}
