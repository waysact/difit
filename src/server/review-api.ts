import { Router, type NextFunction, type Request, type Response } from 'express';

import type { ReviewStore } from '../types/review.js';

import { requireReviewIdentity, reviewBodyParser, reviewErrors } from './review-http.js';

/** Leaves existing browser API routes outside the agent identity contract. */
function isReviewRoute(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return /^\/(session|events|threads|session\/result)\/?$/i.test(req.path);
  }
  if (req.method === 'POST') {
    return /^\/(session\/stop|threads\/[^/]+\/messages)\/?$/i.test(req.path);
  }
  return req.method === 'PATCH' && /^\/threads\/[^/]+\/?$/i.test(req.path);
}

function invalid(
  message: string,
  code: 'invalid_request' | 'version_required' | 'invalid_cursor' = 'invalid_request',
): never {
  throw Object.assign(new Error(message), { code });
}

function validateQuery(req: Request, allowed: string[] = []): void {
  if (Object.keys(req.query).some((key) => !allowed.includes(key))) {
    invalid('Unsupported review query parameter');
  }
}

function bodyRecord(req: Request, allowed: string[]): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    invalid('Expected a JSON object');
  }
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    invalid('Unsupported review body field');
  }
  return body as Record<string, unknown>;
}

function nonempty(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid('Expected a nonempty string');
  return value;
}

function version(value: unknown): number {
  if (value === undefined) invalid('A comment version is required', 'version_required');
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid('Expected a safe nonnegative integer version');
  }
  return value;
}

function cursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    invalid('Expected a safe nonnegative integer cursor', 'invalid_cursor');
  }
  return Number(value);
}

function waitMs(value: unknown): number {
  if (value === undefined) return 0;
  if (
    typeof value !== 'string' ||
    !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
    !Number.isFinite(Number(value))
  ) {
    invalid('Expected finite nonnegative wait seconds');
  }
  return Math.min(Number(value), 25) * 1000;
}

/** Checks, subscribes and arms cleanup without yielding between them. */
function waitForReview(
  store: ReviewStore,
  req: Request,
  res: Response,
  next: NextFunction,
  duration: number,
  respond: (expired: boolean) => boolean,
): void {
  if (req.aborted || res.destroyed || respond(duration === 0)) return;
  let settled = false;
  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    clearTimeout(timer);
    res.off('close', cleanup);
  };
  const wake = (expired: boolean): void => {
    if (settled) return;
    try {
      if (respond(expired)) cleanup();
    } catch (error) {
      cleanup();
      next(error);
    }
  };
  const unsubscribe = store.subscribe(() => wake(false));
  const timer = setTimeout(() => wake(true), duration);
  res.once('close', cleanup);
}

/** Mount before general JSON parsing so identity and parse errors stay route-scoped. */
export function createReviewRouter({
  store,
  shutdown,
}: {
  store: ReviewStore;
  shutdown: (response: Response) => void;
}): Router {
  const router = Router();
  let shutdownStarted = false;
  const parseBody = reviewBodyParser();

  router.use((req, res, next) => {
    if (isReviewRoute(req)) {
      res.set('Cache-Control', 'no-store');
      requireReviewIdentity(req, store);
    }
    next();
  });
  router.get('/session', (req, res) => {
    validateQuery(req);
    res.json({ session: store.snapshot().session });
  });
  router.get('/threads', (req, res) => {
    validateQuery(req);
    res.json(store.snapshot());
  });
  router.get('/events', (req, res, next) => {
    validateQuery(req, ['after', 'wait']);
    const after = cursor(req.query.after);
    waitForReview(store, req, res, next, waitMs(req.query.wait), (expired) => {
      const page = store.page(after);
      if (!expired && page.events.length === 0 && page.session.state === 'active') return false;
      res.json(page);
      return true;
    });
  });
  router.get('/session/result', (req, res, next) => {
    validateQuery(req, ['wait']);
    waitForReview(store, req, res, next, waitMs(req.query.wait), (expired) => {
      const snapshot = store.snapshot();
      const finished = snapshot.session.state === 'finished';
      if (!expired && !finished) return false;
      res.status(finished ? 200 : 202).json(finished ? snapshot : { session: snapshot.session });
      return true;
    });
  });
  router.post('/threads/:id/messages', parseBody, (req, res) => {
    validateQuery(req);
    const body = bodyRecord(req, ['id', 'body', 'expectedVersion']);
    const result = store.reply(nonempty(req.params.id), {
      id: nonempty(body.id),
      body: nonempty(body.body),
      expectedVersion: version(body.expectedVersion),
    });
    res.json({ ...result.snapshot, message: result.message, replayed: result.replayed });
  });
  router.patch('/threads/:id', parseBody, (req, res) => {
    validateQuery(req);
    const body = bodyRecord(req, ['resolved', 'expectedVersion']);
    if (typeof body.resolved !== 'boolean') invalid('Expected boolean resolution');
    res.json(
      store.setResolved(nonempty(req.params.id), body.resolved, version(body.expectedVersion)),
    );
  });
  router.post('/session/stop', parseBody, (req, res) => {
    validateQuery(req);
    if (
      req.body === undefined &&
      (req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0)
    ) {
      invalid('Expected a JSON request body');
    }
    if (req.body !== undefined) bodyRecord(req, []);
    const snapshot = store.beginStop();
    if (!shutdownStarted) {
      shutdownStarted = true;
      shutdown(res);
    }
    res.json(snapshot);
  });
  router.use(reviewErrors(store, isReviewRoute));
  return router;
}
