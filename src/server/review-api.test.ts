import { once } from 'node:events';
import type { Server } from 'node:http';

import express, { type Response } from 'express';
import { fetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewStore, ReviewThread } from '../types/review.js';
import { createReviewRouter } from './review-api.js';
import { createReviewStore } from './review-store.js';
import { testHttpUrl } from './test-http-url.js';

const thread: ReviewThread = {
  id: 't1',
  filePath: 'file.ts',
  resolved: false,
  position: { side: 'new', line: 1 },
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:00:00.000Z',
  messages: [],
};

describe('review REST API', () => {
  let server: Server;
  let base: string;
  let store: ReviewStore;
  let shutdown: ReturnType<typeof vi.fn<(response: Response) => void>>;

  beforeEach(async () => {
    store = createReviewStore({
      sessionId: 'review-A',
      selectionKey: 'launch',
      initialThreads: [thread],
      selection: {
        requestedBase: 'HEAD^',
        requestedTarget: 'HEAD',
        resolvedBase: 'base-sha',
        resolvedTarget: 'target-sha',
        baseMode: 'direct',
      },
      limits: { idleGraceMs: 10_000, timeoutMs: 3_600_000, cleanupGraceMs: 300_000 },
      now: () => new Date('2026-09-05T10:00:00.000Z'),
    });
    shutdown = vi.fn();
    const app = express();
    app.use('/api', createReviewRouter({ store, shutdown }));
    app.use(express.json());
    app.get('/api/legacy', (_req, res) => res.json({ legacy: true }));
    server = app.listen(0);
    await once(server, 'listening');
    base = testHttpUrl(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP listener required');
    store.setConnection({
      publicUrl: base,
      apiUrl: `${base}/api`,
      port: address.port,
      pid: process.pid,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    vi.restoreAllMocks();
  });

  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { 'X-Difit-Session': 'review-A', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it.each([
    ['GET', '/session'],
    ['GET', '/events?after=1&wait=25'],
    ['GET', '/threads'],
    ['GET', '/session/result?wait=25'],
    ['POST', '/threads/t1/messages'],
    ['PATCH', '/threads/t1'],
    ['POST', '/session/stop'],
    ['HEAD', '/session'],
    ['HEAD', '/events?after=1&wait=0'],
    ['HEAD', '/threads'],
    ['HEAD', '/session/result?wait=0'],
  ])('checks missing and stale identity on %s %s before work', async (method, path) => {
    const subscribe = vi.spyOn(store, 'subscribe');
    for (const [headers, status, code] of [
      [{}, 400, 'session_required'],
      [{ 'X-Difit-Session': 'old-process' }, 409, 'session_mismatch'],
    ] as const) {
      const response = await fetch(`${base}/api${path}`, { method, headers });
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      if (method !== 'HEAD') {
        expect(await response.json()).toMatchObject({
          error: { code },
          sessionId: 'review-A',
          version: 1,
        });
      }
    }
    expect(subscribe).not.toHaveBeenCalled();
    expect(store.snapshot()).toMatchObject({ version: 1, cursor: 1, session: { state: 'active' } });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('does not gate unrelated API routes', async () => {
    const response = await fetch(`${base}/api/legacy`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ legacy: true });
  });

  it('rejects an old session at the same cursor after the listener port is reused', async () => {
    const original = store.snapshot();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store = createReviewStore({
      sessionId: 'review-B',
      selectionKey: 'launch',
      initialThreads: [thread],
      selection: original.session.selection,
      limits: original.session.limits,
      now: () => new Date('2026-09-05T10:00:00.000Z'),
    });
    const app = express();
    app.use('/api', createReviewRouter({ store, shutdown }));
    server = app.listen(original.session.port);
    await once(server, 'listening');
    store.setConnection({
      publicUrl: base,
      apiUrl: `${base}/api`,
      port: original.session.port,
      pid: process.pid,
    });
    const subscribe = vi.spyOn(store, 'subscribe');
    expect(store.snapshot().cursor).toBe(original.cursor);
    const response = await request('/events?after=1&wait=25');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'session_mismatch' },
      sessionId: 'review-B',
      version: 1,
    });
    const stop = await request('/session/stop', 'POST');
    expect(stop.status).toBe(409);
    expect(store.snapshot().session.state).toBe('active');
    expect(subscribe).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('returns selected session metadata and consistent thread snapshots', async () => {
    const session = await request('/session');
    expect(session.headers.get('cache-control')).toBe('no-store');
    expect(await session.json()).toEqual({ session: store.snapshot().session });
    const threads = await request('/threads');
    expect(threads.status).toBe(200);
    expect(await threads.json()).toEqual(store.snapshot());
  });

  it.each([
    ['/events?after=', 'invalid_cursor'],
    ['/events?after=1x', 'invalid_cursor'],
    ['/events?after=-1', 'invalid_cursor'],
    ['/events?after=1.1', 'invalid_cursor'],
    ['/events?after=9007199254740992', 'invalid_cursor'],
    ['/events?after=2', 'invalid_cursor'],
    ['/events?after=1&after=1', 'invalid_cursor'],
    ['/events?wait=', 'invalid_request'],
    ['/events?wait=-1', 'invalid_request'],
    ['/events?wait=Infinity', 'invalid_request'],
    ['/events?wait=NaN', 'invalid_request'],
    ['/events?wait=1x', 'invalid_request'],
    ['/events?wait=1&wait=2', 'invalid_request'],
    ['/session/result?wait=-1', 'invalid_request'],
    ['/threads?base=main', 'invalid_request'],
    ['/session?target=HEAD', 'invalid_request'],
    ['/events?limit=5', 'invalid_request'],
  ])('rejects malformed or unsupported query %s', async (path, code) => {
    const response = await request(path);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      error: { code },
      sessionId: 'review-A',
      version: 1,
    });
  });

  it.each([
    [{ id: 'a1', body: 'reply' }, 'version_required'],
    [{ id: 'a1', body: 'reply', expectedVersion: '1' }, 'invalid_request'],
    [{ id: 'a1', body: 'reply', expectedVersion: 1.1 }, 'invalid_request'],
    [{ id: 'a1', body: 'reply', expectedVersion: -1 }, 'invalid_request'],
    [{ id: 'a1', body: 'reply', expectedVersion: 9007199254740992 }, 'invalid_request'],
    [{ id: '', body: 'reply', expectedVersion: 1 }, 'invalid_request'],
    [{ id: 'a1', body: ' ', expectedVersion: 1 }, 'invalid_request'],
    [{ id: 1, body: 'reply', expectedVersion: 1 }, 'invalid_request'],
    [{ id: 'a1', body: 4, expectedVersion: 1 }, 'invalid_request'],
    [{ id: 'a1', body: 'reply', expectedVersion: 1, target: 'other' }, 'invalid_request'],
    [[], 'invalid_request'],
    [null, 'invalid_request'],
  ])('rejects invalid reply body %j', async (body, code) => {
    const response = await request('/threads/t1/messages', 'POST', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code },
      sessionId: 'review-A',
      version: 1,
    });
    expect(store.snapshot().version).toBe(1);
  });

  it.each([
    ['PATCH', '/threads/t1', { resolved: 'true', expectedVersion: 1 }],
    ['PATCH', '/threads/%20', { resolved: true, expectedVersion: 1 }],
    ['PATCH', '/threads/%E0%A4%A', { resolved: true, expectedVersion: 1 }],
    ['POST', '/session/stop', { target: 'other' }],
  ])('rejects malformed %s %s without changing state', async (method, path, body) => {
    const response = await request(path, method, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(store.snapshot().version).toBe(1);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('checks identity before parsing and normalizes malformed JSON', async () => {
    for (const [identity, status, code] of [
      ['review-A', 400, 'invalid_request'],
      ['old-process', 409, 'session_mismatch'],
      ['', 400, 'session_required'],
    ] as const) {
      const response = await fetch(`${base}/api/threads/t1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Difit-Session': identity },
        body: '{',
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ error: { code }, version: 1 });
    }
  });

  it('rejects a non-JSON stop body instead of silently accepting it as an empty request', async () => {
    const response = await fetch(`${base}/api/session/stop`, {
      method: 'POST',
      headers: { 'X-Difit-Session': 'review-A', 'Content-Type': 'text/plain' },
      body: 'not JSON',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(store.snapshot().session.state).toBe('active');
    expect(shutdown).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    headers: Record<string, string>;
    body: string | Uint8Array;
    message: RegExp;
  }>([
    {
      name: 'unsupported charset',
      headers: { 'Content-Type': 'application/json; charset=iso-8859-1' },
      body: '{}',
      message: /unsupported.*charset/i,
    },
    {
      name: 'unsupported encoding',
      headers: { 'Content-Encoding': 'compress' },
      body: '{}',
      message: /unsupported.*encoding/i,
    },
    {
      name: 'oversized entity',
      headers: {},
      body: JSON.stringify({ id: 'a1', body: 'a'.repeat(102_401), expectedVersion: 1 }),
      message: /too large/i,
    },
    {
      name: 'malformed gzip',
      headers: { 'Content-Encoding': 'gzip' },
      body: '{}',
      message: /compressed/i,
    },
    {
      name: 'truncated gzip',
      headers: { 'Content-Encoding': 'gzip' },
      body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
      message: /compressed/i,
    },
  ])(
    'normalizes $name on every mutation without changing review state',
    async ({ headers, body, message }) => {
      for (const [method, path] of [
        ['POST', '/threads/t1/messages'],
        ['PATCH', '/threads/t1'],
        ['POST', '/session/stop'],
      ] as const) {
        const response = await fetch(`${base}/api${path}`, {
          method,
          headers: {
            'X-Difit-Session': 'review-A',
            'Content-Type': 'application/json',
            ...headers,
          },
          body,
        });
        expect(response.status).toBe(400);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await response.json()).toEqual({
          error: { code: 'invalid_request', message: expect.stringMatching(message) },
          sessionId: 'review-A',
          version: 1,
        });
        expect(store.snapshot()).toMatchObject({
          version: 1,
          cursor: 1,
          session: { state: 'active' },
        });
        expect(shutdown).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps parser stream configuration failures as server errors', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.setEncoding('utf8');
      next();
    });
    app.use('/api', createReviewRouter({ store, shutdown }));
    server.removeAllListeners('request');
    server.on('request', app);
    const response = await request('/session/stop', 'POST', {});
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('invalid_request');
    expect(store.snapshot().session.state).toBe('active');
    expect(shutdown).not.toHaveBeenCalled();
  });

  it.each([
    { status: 400 },
    { status: 413, type: 'entity.too.large' },
    { status: 400, code: 'Z_DATA_ERROR' },
  ])('does not classify store errors carrying %j as client body errors', async (properties) => {
    vi.spyOn(store, 'reply').mockImplementation(() => {
      throw Object.assign(new Error('unexpected internal validation failure'), properties);
    });
    const response = await request('/threads/t1/messages', 'POST', {
      id: 'a1',
      body: 'reply',
      expectedVersion: 1,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('invalid_request');
    expect(store.snapshot().version).toBe(1);
  });

  it('returns reply snapshots, idempotent replay and machine-readable conflicts', async () => {
    const body = { id: 'a1', body: 'Fixed', expectedVersion: 1 };
    const first = await request('/threads/t1/messages', 'POST', body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      version: 2,
      cursor: 2,
      replayed: false,
      message: { id: 'a1', author: 'Agent', body: 'Fixed' },
    });
    const replay = await request('/threads/t1/messages', 'POST', body);
    expect(await replay.json()).toMatchObject({ version: 2, cursor: 2, replayed: true });
    const stale = await request('/threads/t1/messages', 'POST', { ...body, id: 'a2' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'version_conflict' }, version: 2 });
    const conflict = await request('/threads/t1/messages', 'POST', { ...body, body: 'different' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'message_id_conflict' } });
    store.replaceUserThreads([thread], 2);
    const deleted = await request('/threads/t1/messages', 'POST', body);
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({ error: { code: 'reply_deleted' } });
  });

  it('changes resolution with a current version and exposes missing threads', async () => {
    const response = await request('/threads/t1', 'PATCH', { resolved: true, expectedVersion: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 2,
      cursor: 2,
      threads: [{ id: 't1', resolved: true }],
    });
    const missing = await request('/threads/missing', 'PATCH', {
      resolved: true,
      expectedVersion: 2,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'thread_not_found' } });
    const events = await request('/events?after=1');
    expect(await events.json()).toMatchObject({
      events: [{ type: 'thread.resolved', actor: 'agent' }],
    });
  });

  it('returns 200 empty pages preserving after and defaults omitted after to zero', async () => {
    const first = await request('/events');
    expect(await first.json()).toMatchObject({
      events: [{ cursor: 1 }],
      nextCursor: 1,
      hasMore: false,
    });
    const empty = await request('/events?after=1&wait=0');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ events: [], nextCursor: 1, hasMore: false });
    const active = await request('/session/result?wait=0');
    expect(active.status).toBe(202);
    expect(await active.json()).toEqual({ session: store.snapshot().session });
  });

  it('paginates at 100 returned events independently for multiple readers', async () => {
    for (let index = 0; index < 104; index++)
      store.reply('t1', { id: `a${index}`, body: 'reply', expectedVersion: index + 1 });
    const pages = await Promise.all([request('/events'), request('/events')]);
    for (const response of pages) {
      const page = (await response.json()) as {
        events: unknown[];
        nextCursor: number;
        hasMore: boolean;
      };
      expect(page.events).toHaveLength(100);
      expect(page).toMatchObject({ nextCursor: 100, hasMore: true });
    }
    const last = await request('/events?after=100');
    expect(await last.json()).toMatchObject({
      events: expect.arrayContaining([
        {
          cursor: 105,
          type: 'message.created',
          actor: 'agent',
          threadId: 't1',
          messageId: 'a103',
          sessionId: 'review-A',
        },
      ]),
      nextCursor: 105,
      hasMore: false,
    });
  });

  it('coordinates shutdown after latching stop and before response completion, once', async () => {
    let finishedResponse = false;
    shutdown.mockImplementation((response) => {
      expect(store.snapshot().session.state).toBe('finished');
      expect(response.headersSent).toBe(false);
      response.once('finish', () => {
        finishedResponse = true;
      });
    });
    const first = await request('/session/stop', 'POST');
    expect(first.status).toBe(200);
    const snapshot = await first.json();
    expect(snapshot).toMatchObject({
      version: 1,
      cursor: 2,
      session: { state: 'finished', reason: 'agent_stop', finishedCursor: 2 },
    });
    expect(finishedResponse).toBe(true);
    const second = await request('/session/stop', 'POST');
    expect(await second.json()).toEqual(snapshot);
    expect(shutdown).toHaveBeenCalledTimes(1);
    const write = await request('/threads/t1', 'PATCH', { resolved: true, expectedVersion: 1 });
    expect(write.status).toBe(409);
    expect(await write.json()).toMatchObject({ error: { code: 'session_stopping' } });
  });

  it('leaves unexpected store errors as server errors', async () => {
    vi.spyOn(store, 'reply').mockImplementation(() => {
      throw new Error('unexpected store failure');
    });
    const response = await request('/threads/t1/messages', 'POST', {
      id: 'a1',
      body: 'reply',
      expectedVersion: 1,
    });
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('invalid_request');
  });

  /** Observes subscription lifetime while preserving the real store's notifications. */
  function observeSubscriptions() {
    const active = new Set<() => void>();
    const unsubscribe = vi.fn();
    const subscribe = store.subscribe.bind(store);
    let registered: (() => void) | undefined;
    const registration = new Promise<void>((resolve) => {
      registered = resolve;
    });
    vi.spyOn(store, 'subscribe').mockImplementation((listener) => {
      active.add(listener);
      const remove = subscribe(listener);
      registered?.();
      return () => {
        unsubscribe();
        active.delete(listener);
        remove();
      };
    });
    const waitForRegistration = async (response: Promise<unknown>) => {
      await Promise.race([registration, response]);
      expect(active.size).toBeGreaterThan(0);
    };
    return { active, unsubscribe, waitForRegistration };
  }

  it('wakes an event reader for a comment immediately after registration', async () => {
    const subscriptions = observeSubscriptions();
    const responsePromise = request('/events?after=1&wait=25');
    await subscriptions.waitForRegistration(responsePromise);
    store.reply('t1', { id: 'a1', body: 'reply', expectedVersion: 1 });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      events: [{ cursor: 2, type: 'message.created' }],
      nextCursor: 2,
    });
    expect(subscriptions.active.size).toBe(0);
    expect(subscriptions.unsubscribe).toHaveBeenCalledTimes(1);
  }, 1500);

  it('keeps result waits through comments and returns the deadline completion snapshot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const subscriptions = observeSubscriptions();
    const responsePromise = request('/session/result?wait=25');
    await subscriptions.waitForRegistration(responsePromise);
    store.reply('t1', { id: 'a1', body: 'reply', expectedVersion: 1 });
    expect(subscriptions.active.size).toBe(1);
    setTimeout(() => store.finish('review_timeout'), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 2,
      cursor: 3,
      session: { state: 'finished', reason: 'review_timeout', finishedCursor: 3 },
    });
    expect(subscriptions.active.size).toBe(0);
    expect(subscriptions.unsubscribe).toHaveBeenCalledTimes(1);
  }, 1500);

  it.each(['/events?after=1', '/session/result'])(
    'caps %s waits to 25 seconds without finishing review',
    async (path) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const subscriptions = observeSubscriptions();
      const responsePromise = request(`${path}${path.includes('?') ? '&' : '?'}wait=100000`);
      await subscriptions.waitForRegistration(responsePromise);
      await vi.advanceTimersByTimeAsync(24_999);
      expect(subscriptions.active.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const response = await responsePromise;
      expect(response.status).toBe(path.startsWith('/events') ? 200 : 202);
      expect(await response.json()).toMatchObject({ session: { state: 'active' } });
      expect(subscriptions.active.size).toBe(0);
      expect(subscriptions.unsubscribe).toHaveBeenCalledTimes(1);
      expect(store.snapshot().session.state).toBe('active');
    },
    1500,
  );

  it('accepts fractional waits and returns fresh active metadata on expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const subscriptions = observeSubscriptions();
    const responsePromise = request('/session/result?wait=.25');
    await subscriptions.waitForRegistration(responsePromise);
    store.reply('t1', { id: 'a1', body: 'reply', expectedVersion: 1 });
    await vi.advanceTimersByTimeAsync(250);
    const response = await responsePromise;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ session: store.snapshot().session });
    expect(subscriptions.active.size).toBe(0);
    expect(subscriptions.unsubscribe).toHaveBeenCalledTimes(1);
  }, 1500);

  it.each(['/events?after=1&wait=25', '/session/result?wait=25'])(
    'cleans up an aborted %s wait without completing review',
    async (path) => {
      const timeout = vi.spyOn(globalThis, 'setTimeout');
      const clear = vi.spyOn(globalThis, 'clearTimeout');
      const subscriptions = observeSubscriptions();
      const controller = new AbortController();
      const responsePromise = fetch(`${base}/api${path}`, {
        headers: { 'X-Difit-Session': 'review-A' },
        signal: controller.signal,
      });
      const outcome = responsePromise.then(
        () => 'resolved',
        () => 'aborted',
      );
      await subscriptions.waitForRegistration(outcome);
      const waitTimerIndex = timeout.mock.calls.findIndex(([, delay]) => delay === 25_000);
      expect(waitTimerIndex).toBeGreaterThanOrEqual(0);
      const waitTimer = timeout.mock.results[waitTimerIndex]?.value as ReturnType<
        typeof setTimeout
      >;
      controller.abort();
      expect(await outcome).toBe('aborted');
      await vi.waitFor(() => expect(subscriptions.active.size).toBe(0));
      expect(subscriptions.unsubscribe).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith(waitTimer);
      expect(store.snapshot().session.state).toBe('active');
      expect(shutdown).not.toHaveBeenCalled();
    },
    1500,
  );

  it('wakes independent event and result readers on the same completion latch', async () => {
    const subscriptions = observeSubscriptions();
    const events = request('/events?after=1&wait=25');
    const result = request('/session/result?wait=25');
    await vi.waitFor(() => expect(subscriptions.active.size).toBe(2));
    const stopped = await request('/session/stop', 'POST');
    const stoppedSnapshot = await stopped.json();
    expect(await (await result).json()).toEqual(stoppedSnapshot);
    expect(await (await events).json()).toMatchObject({
      events: [{ cursor: 2, type: 'review.finished', actor: 'system' }],
      nextCursor: 2,
    });
    expect(subscriptions.active.size).toBe(0);
    expect(subscriptions.unsubscribe).toHaveBeenCalledTimes(2);
  }, 1500);

  it('returns immediately when finished or events already exist, including empty finished pages', async () => {
    const subscribe = vi.spyOn(store, 'subscribe');
    const available = await request('/events?wait=25');
    expect(available.status).toBe(200);
    store.finish('browser_idle');
    const result = await request('/session/result?wait=25');
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(store.snapshot());
    const empty = await request('/events?after=2&wait=25');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ events: [], nextCursor: 2, hasMore: false });
    expect(subscribe).not.toHaveBeenCalled();
  }, 1500);

  it('cleans up a waiter and surfaces an unexpected error during notification', async () => {
    const subscriptions = observeSubscriptions();
    const responsePromise = request('/events?after=1&wait=25');
    await subscriptions.waitForRegistration(responsePromise);
    vi.spyOn(store, 'page').mockImplementationOnce(() => {
      throw new Error('unexpected journal failure');
    });
    store.reply('t1', { id: 'a1', body: 'reply', expectedVersion: 1 });
    const response = await responsePromise;
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('invalid_request');
    expect(subscriptions.active.size).toBe(0);
    expect(subscriptions.unsubscribe).toHaveBeenCalledTimes(1);
  }, 1500);

  it('rejects a wrong-session stop without finishing or coordinating shutdown', async () => {
    const response = await fetch(`${base}/api/session/stop`, {
      method: 'POST',
      headers: { 'X-Difit-Session': 'review-B' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'session_mismatch' },
      sessionId: 'review-A',
      version: 1,
    });
    expect(store.snapshot().session.state).toBe('active');
    expect(shutdown).not.toHaveBeenCalled();
  });
});
