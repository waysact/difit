import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReviewInfo, ReviewThread } from '../../types/review';
import { storageService } from '../services/StorageService';
import { applyReviewEdits, type PendingReviewEdit } from '../utils/reviewEdits';

type ReviewSyncStatus =
  | 'loading'
  | 'saved'
  | 'saving'
  | 'conflict'
  | 'unsaved'
  | 'closed'
  | 'error';

interface ReviewSyncOptions {
  contextKey: string;
  readUrl: string;
  writeUrl: string;
  onServerThreads: (threads: ReviewThread[]) => void;
}

interface ReviewCommentsPayload {
  sessionId?: string;
  review?: ReviewInfo | null;
  version?: number;
  threads?: ReviewThread[];
}

interface AcknowledgedReview {
  session: ReviewInfo;
  threads: ReviewThread[];
  version: number;
}

/** Convert legacy thread payloads into the resolved-state shape the review client renders. */
export function normalizeReviewThreads(value: unknown): ReviewThread[] {
  if (!Array.isArray(value)) return [];
  return value.map((thread) => ({
    ...(thread as ReviewThread),
    resolved: (thread as ReviewThread).resolved ?? false,
  }));
}

/** Coordinate browser edits against one selection-pinned review snapshot. */
export function useReviewSync({
  contextKey,
  readUrl,
  writeUrl,
  onServerThreads,
}: ReviewSyncOptions): {
  session: ReviewInfo | null;
  /** Version of the server collection last read or acknowledged; null before the first read. */
  version: number | null;
  pending: PendingReviewEdit[];
  status: ReviewSyncStatus;
  enqueue: (edit: PendingReviewEdit) => void;
  refresh: () => Promise<void>;
  retry: () => Promise<void>;
  discard: () => void;
} {
  const [session, setSession] = useState<ReviewInfo | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingReviewEdit[]>([]);
  const [status, setStatus] = useState<ReviewSyncStatus>('loading');
  const sessionRef = useRef<ReviewInfo | null>(null);
  const acknowledgedRef = useRef<AcknowledgedReview | null>(null);
  const pendingRef = useRef<PendingReviewEdit[]>([]);
  const draftSessionIdRef = useRef<string | null>(null);
  const statusRef = useRef<ReviewSyncStatus>('loading');
  const onServerThreadsRef = useRef(onServerThreads);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const requestGenerationRef = useRef(0);
  const inFlightRef = useRef(false);
  onServerThreadsRef.current = onServerThreads;

  const setSyncStatus = useCallback((next: ReviewSyncStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const replacePending = useCallback(
    (next: PendingReviewEdit[]) => {
      pendingRef.current = next;
      setPending(next);
      const activeSession = sessionRef.current;
      const draftSessionId = draftSessionIdRef.current ?? activeSession?.sessionId;
      if (draftSessionId) {
        storageService.saveReviewDraft(draftSessionId, contextKey, next);
      }
    },
    [contextKey],
  );

  const refresh = useCallback(async (): Promise<void> => {
    // An empty context key means the browser has not resolved a selection yet. Reading without one
    // would ask the server about whichever selection it currently holds, which is not necessarily
    // the one this view is about to show.
    if (!contextKey) return;

    const generation = requestGenerationRef.current;
    let payload: ReviewCommentsPayload;
    try {
      const response = await fetch(readUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch review comments: ${response.status} ${response.statusText}`,
        );
      }
      payload = (await response.json()) as ReviewCommentsPayload;
    } catch (error) {
      // A read that fails while nothing is queued leaves the page showing a state the server can
      // no longer vouch for -- the review may have finished, or the process may be gone. Report
      // that rather than a stale 'saved'. Queued or in-flight work keeps its own status: those
      // states already say the server has not accepted what is on screen.
      if (
        generation === requestGenerationRef.current &&
        (statusRef.current === 'loading' ||
          (statusRef.current === 'saved' && pendingRef.current.length === 0))
      ) {
        setSyncStatus('error');
      }
      throw error;
    }
    if (generation !== requestGenerationRef.current) return;

    const nextSession = payload.review ?? null;
    const nextThreads = normalizeReviewThreads(payload.threads);
    const priorSessionId = sessionRef.current?.sessionId;
    const sessionChanged = priorSessionId !== nextSession?.sessionId;

    // A read issued before a write can be answered after it. Adopting that older payload would drop
    // the just-saved comment from the view and set a base version the server has moved past, so the
    // next write would conflict for no reason the user could understand.
    const acknowledged = acknowledgedRef.current;
    if (
      acknowledged &&
      nextSession &&
      acknowledged.session.sessionId === nextSession.sessionId &&
      typeof payload.version === 'number' &&
      payload.version < acknowledged.version
    ) {
      return;
    }

    onServerThreadsRef.current(nextThreads);
    sessionRef.current = nextSession;
    setSession(nextSession);
    setVersion(typeof payload.version === 'number' ? payload.version : null);
    acknowledgedRef.current =
      nextSession && typeof payload.version === 'number'
        ? { session: nextSession, threads: nextThreads, version: payload.version }
        : null;

    if (!nextSession) {
      setSyncStatus(pendingRef.current.length > 0 ? 'closed' : 'saved');
      return;
    }

    if (sessionChanged) {
      if (pendingRef.current.length > 0 && priorSessionId) {
        draftSessionIdRef.current = draftSessionIdRef.current ?? priorSessionId;
      } else {
        const own = storageService.getReviewDraft(nextSession.sessionId, contextKey);
        // A review that ended while the tab was closed leaves work under a session id no live
        // process will ever match again. Offer it back for copying or discarding; the write gate
        // refuses to send it, because it was written against a review that is gone.
        const foreign = own
          ? undefined
          : storageService
              .getReviewDraftsForSelection(contextKey)
              .find((candidate) => candidate.sessionId !== nextSession.sessionId);
        const draft = own ?? foreign?.edits ?? [];
        draftSessionIdRef.current = foreign?.sessionId ?? nextSession.sessionId;
        pendingRef.current = draft;
        setPending(draft);
      }
    }

    if (
      nextSession.state === 'finished' ||
      (pendingRef.current.length > 0 && draftSessionIdRef.current !== nextSession.sessionId)
    ) {
      setSyncStatus('closed');
    } else if (pendingRef.current.length === 0) {
      setSyncStatus('saved');
    } else if (statusRef.current !== 'conflict') {
      setSyncStatus('unsaved');
    }
  }, [contextKey, readUrl, setSyncStatus]);
  refreshRef.current = refresh;

  const writePending = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    const activeSession = sessionRef.current;
    const acknowledged = acknowledgedRef.current;
    const batch = pendingRef.current;
    if (!activeSession || !acknowledged || batch.length === 0) return;
    if (
      activeSession.state === 'finished' ||
      draftSessionIdRef.current !== activeSession.sessionId
    ) {
      setSyncStatus('closed');
      return;
    }

    const projection = applyReviewEdits(acknowledged.threads, batch);
    if (!projection.ok) {
      setSyncStatus('conflict');
      return;
    }

    const generation = requestGenerationRef.current;
    inFlightRef.current = true;
    setSyncStatus('saving');
    let hasRemainingWork = false;
    try {
      const response = await fetch(writeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Difit-Session': activeSession.sessionId,
        },
        body: JSON.stringify({ threads: projection.threads, baseVersion: acknowledged.version }),
      });

      if (generation !== requestGenerationRef.current) return;

      if (response.status === 409) {
        try {
          await refresh();
        } finally {
          if (generation === requestGenerationRef.current) {
            const current = sessionRef.current;
            const writable =
              current !== null &&
              current.state === 'active' &&
              draftSessionIdRef.current === current.sessionId;
            setSyncStatus(writable ? 'conflict' : 'closed');
          }
        }
        return;
      }

      if (!response.ok) {
        console.error(`Failed to save review comments: ${response.status} ${response.statusText}`);
        setSyncStatus('unsaved');
        return;
      }

      const payload = (await response.json()) as ReviewCommentsPayload;
      const nextThreads = normalizeReviewThreads(payload.threads);
      const nextVersion = payload.version;
      if (typeof nextVersion !== 'number') {
        throw new Error('Review save response did not include a version');
      }
      // A refresh may already have adopted a newer version while this write was outstanding, so
      // the write's own payload must not drag the acknowledged snapshot backwards either.
      const adopted = acknowledgedRef.current;
      if (
        !adopted ||
        adopted.session.sessionId !== activeSession.sessionId ||
        nextVersion >= adopted.version
      ) {
        acknowledgedRef.current = {
          session: activeSession,
          threads: nextThreads,
          version: nextVersion,
        };
        setVersion(nextVersion);
        onServerThreadsRef.current(nextThreads);
      }

      const queuedNow = pendingRef.current;
      const batchIsPrefix = batch.every((edit, index) => queuedNow[index] === edit);
      const remaining = batchIsPrefix ? queuedNow.slice(batch.length) : queuedNow;
      replacePending(remaining);
      // Work queued while this write was in flight is not saved yet; the drain below sends it.
      hasRemainingWork = remaining.length > 0;
      setSyncStatus(hasRemainingWork ? 'unsaved' : 'saved');
    } catch (error) {
      if (generation === requestGenerationRef.current) {
        console.error('Failed to save review comments:', error);
        setSyncStatus(sessionRef.current?.state === 'finished' ? 'closed' : 'unsaved');
      }
    } finally {
      inFlightRef.current = false;
      if (hasRemainingWork && generation === requestGenerationRef.current) {
        void writePending();
      }
    }
  }, [refresh, replacePending, setSyncStatus, writeUrl]);

  const enqueue = useCallback(
    (edit: PendingReviewEdit) => {
      if (
        !sessionRef.current ||
        sessionRef.current.state === 'finished' ||
        (pendingRef.current.length > 0 &&
          draftSessionIdRef.current !== sessionRef.current.sessionId)
      ) {
        console.error('Refusing to queue a review edit: this review no longer accepts input');
        setSyncStatus(sessionRef.current?.state === 'finished' ? 'closed' : 'unsaved');
        return;
      }
      draftSessionIdRef.current = sessionRef.current.sessionId;
      replacePending([...pendingRef.current, edit]);
      setSyncStatus('unsaved');
      void writePending();
    },
    [replacePending, setSyncStatus, writePending],
  );

  const retry = useCallback(async (): Promise<void> => {
    if (
      sessionRef.current?.state === 'finished' ||
      draftSessionIdRef.current !== sessionRef.current?.sessionId
    ) {
      setSyncStatus('closed');
      return;
    }
    await writePending();
  }, [setSyncStatus, writePending]);

  const discard = useCallback(() => {
    replacePending([]);
    draftSessionIdRef.current = sessionRef.current?.sessionId ?? null;
    setSyncStatus(sessionRef.current?.state === 'finished' ? 'closed' : 'saved');
  }, [replacePending, setSyncStatus]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    sessionRef.current = null;
    acknowledgedRef.current = null;
    pendingRef.current = [];
    draftSessionIdRef.current = null;
    setSession(null);
    setVersion(null);
    setPending([]);
    setSyncStatus('loading');

    void refreshRef.current().catch((error) => {
      console.error('Failed to refresh review comments:', error);
    });

    return () => {
      requestGenerationRef.current += 1;
    };
  }, [contextKey, readUrl, setSyncStatus, writeUrl]);

  return { session, version, pending, status, enqueue, refresh, retry, discard };
}
