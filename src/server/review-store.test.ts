import { describe, expect, it } from 'vitest';

import { must } from '../test/must.js';
import type { DiffCommentMessage } from '../types/diff.js';
import type { ReviewSnapshot, ReviewStoreOptions, ReviewThread } from '../types/review.js';
import { createReviewStore } from './review-store.js';

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
const makeStore = (overrides: Partial<ReviewStoreOptions> = {}) =>
  createReviewStore({
    sessionId: 'review-A',
    selectionKey: 'launch',
    initialThreads: [],
    selection: {
      requestedBase: 'HEAD^',
      requestedTarget: 'HEAD',
      resolvedBase: 'base-sha',
      resolvedTarget: 'target-sha',
      baseMode: 'direct',
    },
    limits: { idleGraceMs: 10_000, timeoutMs: 3_600_000, cleanupGraceMs: 300_000 },
    now: () => new Date('2026-09-05T10:00:00.000Z'),
    ...overrides,
  });

describe('review store', () => {
  it('treats absent and undefined optional JSON fields identically across initial and replacement writes', () => {
    const input = {
      ...thread,
      codeSnapshot: { content: 'code', language: undefined },
      messages: [{ ...firstMessage, author: undefined }],
    };
    const store = makeStore({ initialThreads: [input] });
    const before = store.snapshot();
    const wireThreads = JSON.parse(JSON.stringify(before.threads)) as ReviewThread[];
    expect(store.replaceUserThreads(wireThreads, before.version)).toEqual(before);
    expect(store.replaceUserThreads([input], before.version)).toEqual(before);
    expect(
      store.replaceUserThreads([{ ...input, codeSnapshot: undefined }], before.version).version,
    ).toBe(before.version + 1);
    const absentSnapshot = store.snapshot();
    const withoutSnapshot: ReviewThread = { ...input };
    delete withoutSnapshot.codeSnapshot;
    expect(store.replaceUserThreads([withoutSnapshot], absentSnapshot.version)).toEqual(
      absentSnapshot,
    );
  });
  it('captures launch options so caller mutation cannot change completion policy', () => {
    const metadata = makeStore().snapshot().session;
    const options: ReviewStoreOptions = {
      sessionId: 'review-A',
      selectionKey: 'launch',
      initialThreads: [],
      selection: metadata.selection,
      limits: metadata.limits,
      now: () => new Date('2026-09-05T10:00:00.000Z'),
      autoCleanup: true,
    };
    const store = createReviewStore(options);
    options.autoCleanup = false;
    options.now = () => new Date('2026-09-05T11:00:00.000Z');
    options.limits.cleanupGraceMs = 1;
    options.selection.requestedBase = 'corrupt';
    expect(store.finish('review_timeout').session).toMatchObject({
      finishedAt: '2026-09-05T10:00:00.000Z',
      cleanupAt: '2026-09-05T10:05:00.000Z',
      selection: { requestedBase: 'HEAD^' },
    });
  });

  it('requires a well-formed version even on an otherwise valid replay', () => {
    const store = makeStore({ initialThreads: [thread] });
    store.reply('t1', { id: 'a1', body: 'reply', expectedVersion: 1 });
    expect(() =>
      store.reply('t1', {
        id: 'a1',
        body: 'reply',
        expectedVersion: undefined as unknown as number,
      }),
    ).toThrow(expect.objectContaining({ code: 'version_required' }));
    expect(() => store.reply('t1', { id: 'a1', body: 'reply', expectedVersion: 1.5 })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('rejects all later writes after stop including ordinary finish', () => {
    const store = makeStore();
    store.beginStop();
    expect(() => store.finish('browser_idle')).toThrow(
      expect.objectContaining({ code: 'session_stopping' }),
    );
  });

  it('keeps reply deletion reserved even after a user reintroduces the same message ID', () => {
    const store = makeStore({ initialThreads: [thread] });
    const reply = { id: 'a1', body: 'reply', expectedVersion: 1 };
    const accepted = store.reply('t1', reply).snapshot;
    store.replaceUserThreads([thread], 2);
    store.replaceUserThreads(accepted.threads, 3);
    expect(() => store.reply('t1', reply)).toThrow(
      expect.objectContaining({ code: 'reply_deleted' }),
    );
  });

  it('copies replacement inputs and mutation results at the boundary', () => {
    const store = makeStore();
    const input = structuredClone(thread);
    const result = store.replaceUserThreads([input], 0);
    must(input.messages[0], 'the cloned fixture thread has one message').body = 'corrupt input';
    const returned = must(result.threads[0], 'the replacement echoes the submitted thread');
    must(returned.messages[0], 'the returned thread keeps its one message').body = 'corrupt output';
    expect(store.snapshot().threads[0]?.messages[0]?.body).toBe('Please fix this');
    expect(store.replaceUserThreads([thread], 1)).toMatchObject({ version: 1, cursor: 2 });
  });

  it('notifies once for completion and does not extend the cleanup deadline', () => {
    const store = makeStore();
    const observed: ReviewSnapshot[] = [];
    store.subscribe(() => observed.push(store.snapshot()));
    store.finish('review_timeout');
    store.finish('browser_idle');
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      version: 0,
      cursor: 1,
      session: { finishedCursor: 1, cleanupAt: '2026-09-05T10:05:00.000Z' },
    });
  });

  it('retains submitted thread order and journals moved threads', () => {
    const store = makeStore({ initialThreads: [thread, { ...thread, id: 't2', messages: [] }] });
    store.replaceUserThreads([{ ...thread, id: 't2', messages: [] }, thread], 1);
    expect(store.snapshot().threads.map((item) => item.id)).toEqual(['t2', 't1']);
    expect(store.page(3).events).toMatchObject([
      { type: 'thread.updated', threadId: 't1' },
      { type: 'thread.updated', threadId: 't2' },
    ]);
  });

  it('retains reordered messages and journals their thread', () => {
    const store = makeStore({
      initialThreads: [{ ...thread, messages: [firstMessage, { ...firstMessage, id: 'm2' }] }],
    });
    const reordered = store.snapshot().threads;
    must(reordered[0], 'the store was seeded with one thread').messages.reverse();
    store.replaceUserThreads(reordered, 1);
    expect(store.snapshot().threads[0]?.messages.map((message) => message.id)).toEqual([
      'm2',
      'm1',
    ]);
    expect(store.page(3).events).toMatchObject([{ type: 'thread.updated', threadId: 't1' }]);
  });

  it('replays the current edited message against the original accepted payload', () => {
    const store = makeStore({ initialThreads: [thread] });
    const reply = { id: 'a1', body: 'reply', expectedVersion: 1 };
    store.reply('t1', reply);
    const edited = store.snapshot().threads;
    const editedThread = must(edited[0], 'the store was seeded with one thread');
    must(editedThread.messages[1], 'the agent reply follows the seeded message').body =
      'user corrected this';
    store.replaceUserThreads(edited, 2);
    expect(store.reply('t1', reply)).toMatchObject({
      replayed: true,
      message: { body: 'user corrected this' },
      snapshot: { version: 3, cursor: 4 },
    });
    expect(() => store.reply('t1', { ...reply, body: 'user corrected this' })).toThrow(
      expect.objectContaining({ code: 'message_id_conflict' }),
    );
  });

  it('copies connection data without changing comment version or cursor', () => {
    const store = makeStore();
    const connection = {
      publicUrl: 'https://difit.example',
      apiUrl: 'http://127.0.0.1:4966',
      port: 4966,
      pid: 42,
    };
    store.setConnection(connection);
    connection.publicUrl = 'corrupt';
    expect(store.snapshot()).toMatchObject({
      version: 0,
      cursor: 0,
      session: {
        publicUrl: 'https://difit.example',
        apiUrl: 'http://127.0.0.1:4966',
        port: 4966,
        pid: 42,
      },
    });
  });

  it('rejects stale deletion without losing an agent reply', () => {
    const store = makeStore();
    const beforeReply = store.replaceUserThreads([thread], 0);
    store.reply('t1', { id: 'a1', body: 'Working on it', expectedVersion: beforeReply.version });
    expect(() => store.replaceUserThreads([], beforeReply.version)).toThrow(
      expect.objectContaining({ code: 'version_conflict' }),
    );
    expect(store.snapshot().threads[0]?.messages).toHaveLength(2);
  });

  it('journals seed imports for a reader starting at zero and normalizes resolution', () => {
    const store = makeStore({ initialThreads: [{ ...thread, resolved: undefined }] });
    expect(store.snapshot()).toMatchObject({
      version: 1,
      cursor: 2,
      threads: [{ resolved: false }],
    });
    expect(store.page(0).events).toEqual([
      { cursor: 1, sessionId: 'review-A', type: 'thread.created', actor: 'user', threadId: 't1' },
      {
        cursor: 2,
        sessionId: 'review-A',
        type: 'message.created',
        actor: 'user',
        threadId: 't1',
        messageId: 'm1',
      },
    ]);
  });

  it('notifies only after the entire collection and its events are committed', () => {
    const store = makeStore();
    const observed: ReviewSnapshot[] = [];
    const stop = store.subscribe(() => {
      observed.push(store.snapshot());
      expect(store.page(0).events).toHaveLength(2);
    });
    store.replaceUserThreads([thread], 0);
    store.replaceUserThreads([thread], 1);
    stop();
    store.setResolved('t1', true, 1);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ version: 1, cursor: 2, threads: [{ id: 't1' }] });
  });

  it('emits distinct message, metadata and resolution events in stable ID order', () => {
    const store = makeStore();
    store.replaceUserThreads([thread], 0);
    const edited = structuredClone(thread);
    must(edited.messages[0], 'the cloned fixture thread has one message').body = 'Corrected';
    edited.updatedAt = '2026-09-05T11:00:00.000Z';
    store.replaceUserThreads([edited], 1);
    expect(store.page(2).events).toMatchObject([
      { type: 'message.updated', messageId: 'm1', actor: 'user' },
    ]);
    edited.filePath = 'renamed.ts';
    edited.position.line = { start: 3, end: 4 };
    edited.codeSnapshot = { content: 'new code', language: 'typescript' };
    edited.resolved = true;
    store.replaceUserThreads([edited], 2);
    expect(store.page(3).events.map((event) => event.type)).toEqual([
      'thread.updated',
      'thread.resolved',
    ]);
    store.setResolved('t1', false, 3);
    expect(store.page(5).events).toMatchObject([{ type: 'thread.reopened', actor: 'agent' }]);
    edited.messages = [];
    edited.resolved = false;
    store.replaceUserThreads([edited], 4);
    expect(store.page(6).events.map((event) => event.type)).toEqual(['message.deleted']);
    store.replaceUserThreads([], 5);
    expect(store.page(7).events.map((event) => event.type)).toEqual(['thread.deleted']);
    expect(store.snapshot()).toMatchObject({ version: 6, cursor: 8 });
  });

  it('includes deleted messages when deleting a thread', () => {
    const store = makeStore();
    store.replaceUserThreads([thread], 0);
    store.replaceUserThreads([], 1);
    expect(store.page(2).events.map((event) => event.type)).toEqual([
      'message.deleted',
      'thread.deleted',
    ]);
  });

  it('sorts changed thread and message IDs independently of collection order', () => {
    const store = makeStore();
    store.replaceUserThreads(
      [
        { ...thread, id: 'z', messages: [] },
        {
          ...thread,
          messages: [
            { ...firstMessage, id: 'z' },
            { ...firstMessage, id: 'a' },
          ],
        },
      ],
      0,
    );
    expect(
      store.page(0).events.map(({ type, threadId, messageId }) => [type, threadId, messageId]),
    ).toEqual([
      ['thread.created', 't1', undefined],
      ['message.created', 't1', 'a'],
      ['message.created', 't1', 'z'],
      ['thread.created', 'z', undefined],
    ]);
  });

  it('rejects stale resolution including no-ops and leaves current no-ops untouched', () => {
    const store = makeStore();
    store.replaceUserThreads([thread], 0);
    expect(() => store.setResolved('t1', false, 0)).toThrow(
      expect.objectContaining({ code: 'version_conflict' }),
    );
    expect(store.setResolved('t1', false, 1)).toMatchObject({ version: 1, cursor: 2 });
    expect(store.setResolved('t1', true, 1)).toMatchObject({ version: 2, cursor: 3 });
    expect(store.page(2).events).toMatchObject([{ type: 'thread.resolved', actor: 'agent' }]);
  });

  it('replays identical replies before stale-version checks without another event', () => {
    const store = makeStore();
    store.replaceUserThreads([thread], 0);
    const reply = { id: 'a1', body: 'Working on it', expectedVersion: 1 };
    expect(store.reply('t1', reply)).toMatchObject({
      replayed: false,
      message: {
        id: 'a1',
        body: 'Working on it',
        author: 'Agent',
        createdAt: '2026-09-05T10:00:00.000Z',
      },
    });
    expect(store.reply('t1', reply)).toMatchObject({
      replayed: true,
      snapshot: { version: 2, cursor: 3 },
    });
    expect(store.page(2).events).toMatchObject([
      { type: 'message.created', actor: 'agent', messageId: 'a1' },
    ]);
    expect(() => store.reply('t1', { ...reply, body: 'Different' })).toThrow(
      expect.objectContaining({ code: 'message_id_conflict' }),
    );
    expect(() => store.reply('missing', reply)).toThrow(
      expect.objectContaining({ code: 'message_id_conflict' }),
    );
  });

  it('reserves deleted reply IDs for the process lifetime', () => {
    const store = makeStore();
    store.replaceUserThreads([thread], 0);
    const reply = { id: 'a1', body: 'Working on it', expectedVersion: 1 };
    store.reply('t1', reply);
    store.replaceUserThreads([thread], 2);
    expect(() => store.reply('t1', reply)).toThrow(
      expect.objectContaining({ code: 'reply_deleted' }),
    );
    store.replaceUserThreads([], 3);
    expect(() => store.reply('t1', reply)).toThrow(
      expect.objectContaining({ code: 'reply_deleted' }),
    );
    expect(store.snapshot().threads).toEqual([]);
  });

  it('rejects reply IDs already held by a user message', () => {
    const store = makeStore({ initialThreads: [thread] });
    expect(() => store.reply('t1', { id: 'm1', body: 'collision', expectedVersion: 1 })).toThrow(
      expect.objectContaining({ code: 'message_id_conflict' }),
    );
  });

  it('does not reserve IDs for rejected new work', () => {
    const store = makeStore({ initialThreads: [thread] });
    expect(() => store.reply('missing', { id: 'a1', body: 'reply', expectedVersion: 1 })).toThrow(
      expect.objectContaining({ code: 'thread_not_found' }),
    );
    expect(() => store.reply('t1', { id: 'a1', body: 'reply', expectedVersion: 0 })).toThrow(
      expect.objectContaining({ code: 'version_conflict' }),
    );
    expect(store.reply('t1', { id: 'a1', body: 'reply', expectedVersion: 1 }).replayed).toBe(false);
    expect(() => store.setResolved('missing', true, 2)).toThrow(
      expect.objectContaining({ code: 'thread_not_found' }),
    );
  });

  it('protects nested inputs and all returned state from caller mutation', () => {
    const imported = structuredClone(thread);
    imported.position.line = { start: 1, end: 2 };
    imported.codeSnapshot = { content: 'original' };
    const store = makeStore({ initialThreads: [imported] });
    imported.position.line.start = 90;
    imported.codeSnapshot.content = 'corrupt';
    must(imported.messages[0], 'the cloned fixture thread has one message').body = 'corrupt';
    const first = store.snapshot();
    first.session.selection.resolvedBase = 'corrupt';
    first.session.limits.timeoutMs = 1;
    const firstThread = must(first.threads[0], 'the snapshot holds the imported thread');
    firstThread.position.line = 90;
    must(firstThread.messages[0], 'the imported thread keeps its one message').body = 'corrupt';
    const page = store.page(0);
    must(page.events[0], 'seeding a thread journals its creation').type = 'review.finished';
    page.session.selection.requestedBase = 'corrupt';
    const reply = store.reply('t1', { id: 'a1', body: 'reply', expectedVersion: 1 });
    reply.message.body = 'corrupt';
    reply.snapshot.threads.length = 0;
    expect(store.snapshot()).toMatchObject({
      session: {
        selection: { requestedBase: 'HEAD^', resolvedBase: 'base-sha' },
        limits: { timeoutMs: 3_600_000 },
      },
      threads: [
        {
          position: { line: { start: 1, end: 2 } },
          codeSnapshot: { content: 'original' },
          messages: [{ body: 'Please fix this' }, { body: 'reply' }],
        },
      ],
    });
    expect(store.page(0).events[0]?.type).toBe('thread.created');
  });

  it('paginates 101 events without advancing independent readers', () => {
    const store = makeStore();
    store.replaceUserThreads(
      [
        {
          ...thread,
          messages: Array.from({ length: 100 }, (_, i) => ({
            ...firstMessage,
            id: `m${i}`,
          })),
        },
      ],
      0,
    );
    const first = store.page(0);
    expect(first.events).toHaveLength(100);
    expect(first).toMatchObject({ nextCursor: 100, hasMore: true });
    expect(store.page(0)).toEqual(first);
    const second = store.page(100);
    expect(second.events).toHaveLength(1);
    expect(second).toMatchObject({ nextCursor: 101, hasMore: false });
    expect(store.page(101)).toMatchObject({ events: [], nextCursor: 101, hasMore: false });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1, '0', null])(
    'rejects invalid/ahead cursor %s',
    (cursor) => {
      expect(() => makeStore().page(cursor as number)).toThrow(
        expect.objectContaining({ code: 'invalid_cursor' }),
      );
    },
  );

  it('finishes once with a stable cutoff while allowing subsequent agent work', () => {
    let now = new Date('2026-09-05T10:00:00.000Z');
    const store = makeStore({ initialThreads: [thread], now: () => now });
    const finished = store.finish('browser_idle');
    expect(finished).toMatchObject({
      version: 1,
      cursor: 3,
      session: {
        state: 'finished',
        reason: 'browser_idle',
        finishedCursor: 3,
        finishedAt: '2026-09-05T10:00:00.000Z',
        cleanupAt: '2026-09-05T10:05:00.000Z',
      },
    });
    now = new Date('2026-09-05T10:01:00.000Z');
    expect(store.finish('review_timeout')).toEqual(finished);
    expect(() => store.replaceUserThreads([], 1)).toThrow(
      expect.objectContaining({ code: 'review_finished' }),
    );
    store.reply('t1', { id: 'a1', body: 'fixed', expectedVersion: 1 });
    store.setResolved('t1', true, 2);
    expect(store.snapshot()).toMatchObject({
      version: 3,
      cursor: 5,
      session: { reason: 'browser_idle', finishedCursor: 3 },
    });
    expect(store.page(2).events.map(({ type, actor }) => [type, actor])).toEqual([
      ['review.finished', 'system'],
      ['message.created', 'agent'],
      ['thread.resolved', 'agent'],
    ]);
  });

  it('latches stop before notification, caches its final snapshot, and gates even replay', () => {
    const store = makeStore({ initialThreads: [thread] });
    const reply = { id: 'a1', body: 'reply', expectedVersion: 1 };
    store.reply('t1', reply);
    let duringStop: ReviewSnapshot | undefined;
    store.subscribe(() => {
      expect(() => store.reply('t1', reply)).toThrow(
        expect.objectContaining({ code: 'session_stopping' }),
      );
      duringStop = store.beginStop();
    });
    const stopped = store.beginStop();
    expect(stopped).toMatchObject({
      version: 2,
      cursor: 4,
      session: { reason: 'agent_stop', finishedCursor: 4 },
    });
    expect(duringStop).toEqual(stopped);
    stopped.threads.length = 0;
    expect(store.beginStop().threads).toHaveLength(1);
    expect(() => store.setResolved('t1', true, 2)).toThrow(
      expect.objectContaining({ code: 'session_stopping' }),
    );
    expect(() => store.replaceUserThreads([], 2)).toThrow(
      expect.objectContaining({ code: 'session_stopping' }),
    );
    expect(() =>
      store.setConnection({ publicUrl: 'changed', apiUrl: 'changed', port: 1, pid: 2 }),
    ).toThrow(expect.objectContaining({ code: 'session_stopping' }));
    expect(store.page(0).events.filter((event) => event.type === 'review.finished')).toHaveLength(
      1,
    );
  });

  it('preserves a prior completion reason and final agent work when stopping', () => {
    const store = makeStore({ initialThreads: [thread], autoCleanup: false });
    store.finish('review_timeout');
    store.reply('t1', { id: 'a1', body: 'reply', expectedVersion: 1 });
    expect(store.beginStop()).toMatchObject({
      cursor: 4,
      session: { reason: 'review_timeout', finishedCursor: 3, cleanupAt: null },
    });
  });

  it.each([undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'])(
    'rejects malformed version %s atomically',
    (version) => {
      const store = makeStore();
      expect(() => store.replaceUserThreads([thread], version as number)).toThrow(
        expect.objectContaining({
          code: version === undefined ? 'version_required' : 'invalid_request',
        }),
      );
      expect(store.snapshot()).toMatchObject({ threads: [], cursor: 0, version: 0 });
    },
  );

  it('rejects malformed reply and resolution values without changing state', () => {
    const store = makeStore({ initialThreads: [thread] });
    for (const input of [
      { id: '', body: 'reply', expectedVersion: 1 },
      { id: 'a1', body: ' ', expectedVersion: 1 },
    ]) {
      expect(() => store.reply('t1', input)).toThrow(
        expect.objectContaining({ code: 'invalid_request' }),
      );
    }
    expect(() => store.setResolved('t1', 'true' as unknown as boolean, 1)).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(store.snapshot()).toMatchObject({ version: 1, cursor: 2 });
  });

  it('rejects duplicate thread/message IDs and malformed collections atomically', () => {
    const store = makeStore();
    for (const threads of [
      [thread, thread],
      [{ ...thread, messages: [firstMessage, firstMessage] }],
      [{ ...thread, resolved: 'true' }],
      null,
    ]) {
      expect(() => store.replaceUserThreads(threads as ReviewThread[], 0)).toThrow(
        expect.objectContaining({ code: 'invalid_request' }),
      );
    }
    expect(store.snapshot()).toMatchObject({ version: 0, cursor: 0, threads: [] });
  });
});
