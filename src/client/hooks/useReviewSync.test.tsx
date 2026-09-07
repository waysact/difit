import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiffCommentMessage } from '../../types/diff';
import type { ReviewInfo, ReviewThread } from '../../types/review';
import { storageService } from '../services/StorageService';
import type { PendingReviewEdit } from '../utils/reviewEdits';

import { useReviewSync } from './useReviewSync';

const session: ReviewInfo = {
  sessionId: 'review-1',
  selectionKey: 'base...target',
  selection: {
    requestedBase: 'base',
    requestedTarget: 'target',
    resolvedBase: 'base',
    resolvedTarget: 'target',
    baseMode: 'direct',
  },
  publicUrl: 'http://localhost:4966',
  apiUrl: 'http://localhost:4966',
  port: 4966,
  pid: 1,
  state: 'active',
  reason: null,
  cursor: 0,
  finishedCursor: null,
  finishedAt: null,
  cleanupAt: null,
  limits: { idleGraceMs: 10_000, timeoutMs: 60_000, cleanupGraceMs: 300_000 },
};

const firstMessage: DiffCommentMessage = {
  id: 'm1',
  body: 'Please fix this',
  author: 'User',
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:00:00.000Z',
};
const thread: ReviewThread = {
  id: 't1',
  filePath: 'file.ts',
  resolved: false,
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:00:00.000Z',
  position: { side: 'new', line: 1 },
  messages: [firstMessage],
};

const response = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
  }) as Response;

describe('useReviewSync', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetAllMocks();
  });

  it('keeps a rejected edit pending after refreshing the authoritative snapshot', async () => {
    const agentReply = {
      id: 'a1',
      body: 'Working on it',
      author: 'Agent',
      createdAt: '2026-09-05T10:01:00.000Z',
      updatedAt: '2026-09-05T10:01:00.000Z',
    };
    const onServerThreads = vi.fn();
    const fetchMock = vi
      .mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockResolvedValueOnce(response({ error: { code: 'version_conflict' } }, 409))
      .mockResolvedValueOnce(
        response({
          sessionId: session.sessionId,
          review: session,
          version: 2,
          threads: [{ ...thread, messages: [...thread.messages, agentReply] }],
        }),
      );

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('saved'));

    act(() => {
      result.current.enqueue({
        kind: 'editMessage',
        threadId: thread.id,
        before: firstMessage,
        body: 'Please fix this before merging',
        updatedAt: '2026-09-05T10:02:00.000Z',
      });
    });

    await waitFor(() => expect(result.current.status).toBe('conflict'));

    expect(result.current.pending).toHaveLength(1);
    expect(onServerThreads).toHaveBeenLastCalledWith([
      { ...thread, messages: [...thread.messages, agentReply] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('saves an edit queued while the first save is in flight after acknowledging the first batch', async () => {
    let resolveFirstWrite: ((value: Response) => void) | undefined;
    const firstWrite = new Promise<Response>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const resolvedThread = { ...thread, resolved: true, updatedAt: '2026-09-05T10:01:00.000Z' };
    const finalThread = {
      ...resolvedThread,
      updatedAt: '2026-09-05T10:02:00.000Z',
      messages: [
        {
          ...firstMessage,
          body: 'Please fix this before merging',
          updatedAt: '2026-09-05T10:02:00.000Z',
        },
      ],
    };
    const fetchMock = vi
      .mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValueOnce(response({ version: 2, threads: [finalThread] }));

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('saved'));
    act(() => {
      result.current.enqueue({
        kind: 'setResolved',
        threadId: thread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    act(() => {
      result.current.enqueue({
        kind: 'editMessage',
        threadId: thread.id,
        before: firstMessage,
        body: 'Please fix this before merging',
        updatedAt: '2026-09-05T10:02:00.000Z',
      });
      resolveFirstWrite?.(response({ version: 2, threads: [resolvedThread] }));
    });

    await waitFor(() => expect(result.current.status).toBe('saved'));

    expect(result.current.pending).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The drain must build on what the first write acknowledged, not on the snapshot the batch
    // started from, or it would send a stale base version and a collection missing the resolution.
    const [, drainRequest] = fetchMock.mock.calls[2] as [string, RequestInit];
    const drainBody = JSON.parse(String(drainRequest.body)) as {
      threads: ReviewThread[];
      baseVersion: number;
    };
    expect(drainBody.baseVersion).toBe(2);
    expect(drainBody.threads[0]).toMatchObject({ resolved: true });
    expect(drainBody.threads[0]?.messages[0]?.body).toBe('Please fix this before merging');
  });

  it('ignores a delayed snapshot from an obsolete selection context', async () => {
    let resolveOldRead: ((value: Response) => void) | undefined;
    const oldRead = new Promise<Response>((resolve) => {
      resolveOldRead = resolve;
    });
    const replacementSession = {
      ...session,
      sessionId: 'review-2',
      selectionKey: 'other...target',
    };
    const replacementThread = { ...thread, id: 'replacement', filePath: 'other.ts' };
    const onServerThreads = vi.fn();
    vi.mocked(global.fetch)
      .mockReturnValueOnce(oldRead)
      .mockResolvedValueOnce(
        response({
          sessionId: replacementSession.sessionId,
          review: replacementSession,
          version: 1,
          threads: [replacementThread],
        }),
      );

    const { result, rerender } = renderHook(
      ({ contextKey, readUrl, writeUrl }) =>
        useReviewSync({ contextKey, readUrl, writeUrl, onServerThreads }),
      {
        initialProps: {
          contextKey: 'repository:base...target',
          readUrl: '/api/comments-json?base=base&target=target',
          writeUrl: '/api/comments?base=base&target=target',
        },
      },
    );

    rerender({
      contextKey: 'repository:other...target',
      readUrl: '/api/comments-json?base=other&target=target',
      writeUrl: '/api/comments?base=other&target=target',
    });
    await waitFor(() => expect(result.current.session?.sessionId).toBe('review-2'));

    await act(async () => {
      resolveOldRead?.(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      );
    });

    expect(result.current.session?.sessionId).toBe('review-2');
    expect(onServerThreads).toHaveBeenLastCalledWith([replacementThread]);
  });

  it('reconciles an explicit retry against the refreshed snapshot, keeping the agent reply', () => {
    const agentReply = {
      id: 'a1',
      body: 'Working on it',
      author: 'Agent',
      createdAt: '2026-09-05T10:01:00.000Z',
      updatedAt: '2026-09-05T10:01:00.000Z',
    };
    const fetchMock = vi
      .mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockResolvedValueOnce(response({ error: { code: 'version_conflict' } }, 409))
      .mockResolvedValueOnce(
        response({
          sessionId: session.sessionId,
          review: session,
          version: 2,
          threads: [{ ...thread, messages: [...thread.messages, agentReply] }],
        }),
      )
      .mockResolvedValueOnce(response({ version: 3, threads: [] }));

    return (async () => {
      const { result } = renderHook(() =>
        useReviewSync({
          contextKey: 'repository:base...target',
          readUrl: '/api/comments-json?base=base&target=target',
          writeUrl: '/api/comments?base=base&target=target',
          onServerThreads: vi.fn(),
        }),
      );
      await waitFor(() => expect(result.current.status).toBe('saved'));

      act(() => {
        result.current.enqueue({
          kind: 'editMessage',
          threadId: thread.id,
          before: firstMessage,
          body: 'Please fix this before merging',
          updatedAt: '2026-09-05T10:02:00.000Z',
        });
      });
      await waitFor(() => expect(result.current.status).toBe('conflict'));
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await act(async () => {
        await result.current.retry();
      });

      const [, retryRequest] = fetchMock.mock.calls[3] as [string, RequestInit];
      const retryBody = JSON.parse(String(retryRequest.body)) as {
        threads: ReviewThread[];
        baseVersion: number;
      };
      expect(retryBody.baseVersion).toBe(2);
      expect(retryBody.threads[0]?.messages).toEqual([
        {
          ...firstMessage,
          body: 'Please fix this before merging',
          updatedAt: '2026-09-05T10:02:00.000Z',
        },
        agentReply,
      ]);
    })();
  });

  it('closes input and keeps the draft when the review finishes during a save', async () => {
    const finished: ReviewInfo = {
      ...session,
      state: 'finished',
      reason: 'review_timeout',
      finishedCursor: 4,
      finishedAt: '2026-09-05T10:05:00.000Z',
    };
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockResolvedValueOnce(response({ error: { code: 'review_finished' } }, 409))
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: finished, version: 1, threads: [thread] }),
      );

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('saved'));

    act(() => {
      result.current.enqueue({
        kind: 'reply',
        threadId: thread.id,
        message: {
          id: 'u2',
          body: 'One more thing',
          author: 'User',
          createdAt: '2026-09-05T10:04:00.000Z',
          updatedAt: '2026-09-05T10:04:00.000Z',
        },
      });
    });

    await waitFor(() => expect(result.current.status).toBe('closed'));
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.session?.state).toBe('finished');
  });

  it('recovers a draft stored by the same review session without sending it', async () => {
    const draft: PendingReviewEdit[] = [
      {
        kind: 'setResolved',
        threadId: thread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      },
    ];
    storageService.saveReviewDraft(session.sessionId, 'repository:base...target', draft);
    const fetchMock = vi
      .mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      );

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('unsaved'));
    expect(result.current.pending).toEqual(draft);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('offers a draft left by a replaced review session without ever sending it', async () => {
    const draft: PendingReviewEdit[] = [
      {
        kind: 'setResolved',
        threadId: thread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      },
    ];
    storageService.saveReviewDraft(session.sessionId, 'repository:base...target', draft);
    const replacement: ReviewInfo = { ...session, sessionId: 'review-2', pid: 2 };
    const fetchMock = vi.mocked(global.fetch).mockResolvedValueOnce(
      response({
        sessionId: replacement.sessionId,
        review: replacement,
        version: 1,
        threads: [thread],
      }),
    );

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );

    // The work is recoverable, but it was written against a review that is gone: it is presented
    // as closed for copying or discarding, and no write is attempted.
    await waitFor(() => expect(result.current.status).toBe('closed'));
    expect(result.current.pending).toEqual(draft);
    expect(result.current.session?.sessionId).toBe('review-2');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.retry();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('closed');
  });

  it('refuses to enqueue onto a review whose draft belongs to an earlier session', async () => {
    storageService.saveReviewDraft(session.sessionId, 'repository:base...target', [
      {
        kind: 'setResolved',
        threadId: thread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      },
    ]);
    const replacement: ReviewInfo = { ...session, sessionId: 'review-2', pid: 2 };
    const fetchMock = vi.mocked(global.fetch).mockResolvedValueOnce(
      response({
        sessionId: replacement.sessionId,
        review: replacement,
        version: 1,
        threads: [thread],
      }),
    );

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('closed'));

    act(() => {
      result.current.enqueue({
        kind: 'reply',
        threadId: thread.id,
        message: {
          id: 'u9',
          body: 'New work',
          author: 'User',
          createdAt: '2026-09-05T10:06:00.000Z',
          updatedAt: '2026-09-05T10:06:00.000Z',
        },
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toHaveLength(1);
  });

  it('discarding a replaced session draft clears it and reopens the review for new work', async () => {
    storageService.saveReviewDraft(session.sessionId, 'repository:base...target', [
      {
        kind: 'setResolved',
        threadId: thread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      },
    ]);
    const replacement: ReviewInfo = { ...session, sessionId: 'review-2', pid: 2 };
    vi.mocked(global.fetch).mockResolvedValueOnce(
      response({
        sessionId: replacement.sessionId,
        review: replacement,
        version: 1,
        threads: [thread],
      }),
    );

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('closed'));

    act(() => {
      result.current.discard();
    });

    expect(result.current.pending).toEqual([]);
    expect(result.current.status).toBe('saved');
    expect(storageService.getReviewDraft(session.sessionId, 'repository:base...target')).toBeNull();
  });

  it('persists queued work so an unexpected unload leaves a recoverable draft', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockReturnValueOnce(new Promise<Response>(() => {}));

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('saved'));

    const edit: PendingReviewEdit = {
      kind: 'setResolved',
      threadId: thread.id,
      before: false,
      resolved: true,
      updatedAt: '2026-09-05T10:01:00.000Z',
    };
    act(() => {
      result.current.enqueue(edit);
    });

    await waitFor(() => expect(result.current.status).toBe('saving'));
    expect(storageService.getReviewDraft(session.sessionId, 'repository:base...target')).toEqual([
      edit,
    ]);
  });

  it('discards a draft on request and stops offering it back', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockReturnValueOnce(new Promise<Response>(() => {}));

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('saved'));

    act(() => {
      result.current.enqueue({
        kind: 'setResolved',
        threadId: thread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      });
    });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    act(() => {
      result.current.discard();
    });

    expect(result.current.pending).toEqual([]);
    expect(storageService.getReviewDraft(session.sessionId, 'repository:base...target')).toBeNull();
  });

  it('stays out of the way until the browser has resolved a selection', async () => {
    const fetchMock = vi.mocked(global.fetch);

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: '',
        readUrl: '/api/comments-json',
        writeUrl: '/api/comments',
        onServerThreads: vi.fn(),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('loading'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.session).toBeNull();
  });

  it('ignores a read answered after a newer write acknowledged a later version', async () => {
    let resolveStaleRead: ((value: Response) => void) | undefined;
    const staleRead = new Promise<Response>((resolve) => {
      resolveStaleRead = resolve;
    });
    const savedThread = { ...thread, resolved: true, updatedAt: '2026-09-05T10:01:00.000Z' };
    const onServerThreads = vi.fn();
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockReturnValueOnce(staleRead)
      .mockResolvedValueOnce(response({ version: 2, threads: [savedThread] }));

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('saved'));

    // A refresh goes out first, then a write is acknowledged while that read is still outstanding.
    void result.current.refresh();
    act(() => {
      result.current.enqueue({
        kind: 'setResolved',
        threadId: thread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      });
    });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(onServerThreads).toHaveBeenLastCalledWith([savedThread]);

    await act(async () => {
      resolveStaleRead?.(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      );
      await Promise.resolve();
    });

    expect(onServerThreads).toHaveBeenLastCalledWith([savedThread]);
  });

  it('reports a failed initial read instead of waiting forever', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      response({ error: 'boom' }, 500) as unknown as Response,
    );

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.session).toBeNull();
  });

  it('reports a later read failure when nothing is queued, and recovers on the next read', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockResolvedValueOnce(response({ error: 'boom' }, 502))
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      );

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('saved'));

    await act(async () => {
      await expect(result.current.refresh()).rejects.toThrow('502');
    });
    expect(result.current.status).toBe('error');
    expect(result.current.session).toEqual(session);

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status).toBe('saved');
  });

  it('keeps reporting unsaved work when a read fails with edits queued', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockResolvedValueOnce(response({ error: { code: 'invalid_request' } }, 400))
      .mockResolvedValueOnce(response({ error: 'boom' }, 502));

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('saved'));

    act(() => {
      result.current.enqueue({
        kind: 'setResolved',
        threadId: thread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      });
    });
    await waitFor(() => expect(result.current.status).toBe('unsaved'));

    await act(async () => {
      await expect(result.current.refresh()).rejects.toThrow('502');
    });
    expect(result.current.status).toBe('unsaved');
    expect(result.current.pending).toHaveLength(1);
  });

  it('keeps the edit queued and reports a write that failed for a reason other than a conflict', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockResolvedValueOnce(response({ error: { code: 'invalid_request' } }, 400));

    const { result } = renderHook(() =>
      useReviewSync({
        contextKey: 'repository:base...target',
        readUrl: '/api/comments-json?base=base&target=target',
        writeUrl: '/api/comments?base=base&target=target',
        onServerThreads: vi.fn(),
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('saved'));

    act(() => {
      result.current.enqueue({
        kind: 'setResolved',
        threadId: thread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      });
    });

    await waitFor(() => expect(result.current.status).toBe('unsaved'));
    expect(result.current.pending).toHaveLength(1);
  });

  it('does not adopt a write response after the selection context changed', async () => {
    let resolveWrite: ((value: Response) => void) | undefined;
    const slowWrite = new Promise<Response>((resolve) => {
      resolveWrite = resolve;
    });
    const onServerThreads = vi.fn();
    const otherSession: ReviewInfo = { ...session, selectionKey: 'other...target' };
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: session, version: 1, threads: [thread] }),
      )
      .mockReturnValueOnce(slowWrite)
      .mockResolvedValueOnce(
        response({ sessionId: session.sessionId, review: otherSession, version: 5, threads: [] }),
      );

    const { result, rerender } = renderHook(
      ({ contextKey, readUrl, writeUrl }) =>
        useReviewSync({ contextKey, readUrl, writeUrl, onServerThreads }),
      {
        initialProps: {
          contextKey: 'repository:base...target',
          readUrl: '/api/comments-json?base=base&target=target',
          writeUrl: '/api/comments?base=base&target=target',
        },
      },
    );
    await waitFor(() => expect(result.current.status).toBe('saved'));

    act(() => {
      result.current.enqueue({
        kind: 'setResolved',
        threadId: thread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      });
    });
    await waitFor(() => expect(result.current.status).toBe('saving'));

    rerender({
      contextKey: 'repository:other...target',
      readUrl: '/api/comments-json?base=other&target=target',
      writeUrl: '/api/comments?base=other&target=target',
    });
    await waitFor(() => expect(result.current.session?.selectionKey).toBe('other...target'));

    await act(async () => {
      resolveWrite?.(response({ version: 2, threads: [{ ...thread, resolved: true }] }));
      await Promise.resolve();
    });

    expect(onServerThreads).toHaveBeenLastCalledWith([]);
    expect(result.current.pending).toEqual([]);
  });
});
