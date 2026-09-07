import { json, type ErrorRequestHandler, type Request, type RequestHandler } from 'express';

import type { ReviewStore } from '../types/review.js';

const errorStatuses = {
  session_required: 400,
  session_mismatch: 409,
  invalid_request: 400,
  invalid_cursor: 400,
  version_required: 400,
  version_conflict: 409,
  thread_not_found: 404,
  message_id_conflict: 409,
  reply_deleted: 409,
  review_finished: 409,
  session_stopping: 409,
} as const;

const bodyErrorMessages = {
  'entity.parse.failed': 'Malformed JSON request',
  'charset.unsupported': 'Unsupported request charset',
  'encoding.unsupported': 'Unsupported request encoding',
  'entity.too.large': 'Request body is too large',
} as const;

/** Validate identity before any selected request parsing or waiter registration. */
export function requireReviewIdentity(req: Request, store: ReviewStore): void {
  const requested = req.get('X-Difit-Session');
  if (!requested)
    throw Object.assign(new Error('Read /api/comments-json and send X-Difit-Session'), {
      code: 'session_required',
    });
  if (requested !== store.snapshot().session.sessionId)
    throw Object.assign(new Error('Session does not match'), { code: 'session_mismatch' });
}

/** Classify failures at their parser origin; unexpected internal errors still surface. */
export function reviewBodyParser(parser: RequestHandler = json()): RequestHandler {
  return (req, res, next) => {
    parser(req, res, (error: unknown) => {
      let message: string | undefined;
      if (error instanceof Error) {
        if (
          'type' in error &&
          typeof error.type === 'string' &&
          Object.hasOwn(bodyErrorMessages, error.type)
        ) {
          message = bodyErrorMessages[error.type as keyof typeof bodyErrorMessages];
        } else if (
          'status' in error &&
          error.status === 400 &&
          'code' in error &&
          (error.code === 'Z_DATA_ERROR' || error.code === 'Z_BUF_ERROR')
        ) {
          message = 'Invalid compressed request body';
        }
      }
      next(
        message === undefined
          ? error
          : Object.assign(new Error(message), { code: 'invalid_request' }),
      );
    });
  };
}

/** Share the error envelope across agent routes and selected legacy adapters. */
export function reviewErrors(
  store: ReviewStore,
  matches: (req: Request) => boolean,
): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (!matches(req)) {
      next(error);
      return;
    }
    res.set('Cache-Control', 'no-store');
    let failure = error;
    if (failure instanceof URIError && 'status' in failure && failure.status === 400) {
      failure = Object.assign(new Error('Malformed route parameter'), { code: 'invalid_request' });
    }
    if (
      failure instanceof Error &&
      'code' in failure &&
      typeof failure.code === 'string' &&
      Object.hasOwn(errorStatuses, failure.code)
    ) {
      const { session, version } = store.snapshot();
      res.status(errorStatuses[failure.code as keyof typeof errorStatuses]).json({
        error: { code: failure.code, message: failure.message },
        sessionId: session.sessionId,
        version,
      });
      return;
    }
    next(failure);
  };
}
