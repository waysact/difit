import { describe, expect, it } from 'vitest';

import { buildReviewSnapshot } from './review-snapshot.js';
import { must } from '../test/must.js';
import type { DiffCommentThread } from '../types/diff.js';
import type { ReviewInfo } from '../types/review.js';

describe('buildReviewSnapshot', () => {
  it('deep-copies REST metadata and normalized nested threads', () => {
    const session: ReviewInfo = {
      sessionId: 'review-A',
      selectionKey: 'launch',
      selection: {
        requestedBase: 'HEAD^',
        requestedTarget: 'HEAD',
        resolvedBase: 'base',
        resolvedTarget: 'target',
        baseMode: 'direct',
      },
      publicUrl: 'https://difit.example',
      apiUrl: 'http://127.0.0.1:4966',
      port: 4966,
      pid: 42,
      state: 'active',
      reason: null,
      cursor: 2,
      finishedCursor: null,
      finishedAt: null,
      cleanupAt: null,
      limits: { idleGraceMs: 10_000, timeoutMs: 3_600_000, cleanupGraceMs: 300_000 },
    };
    const original: DiffCommentThread = {
      id: 't1',
      filePath: 'file.ts',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
      position: { side: 'new', line: { start: 1, end: 2 } },
      codeSnapshot: { content: 'code' },
      messages: [
        {
          id: 'm1',
          body: 'fix',
          createdAt: '2026-09-05T10:00:00.000Z',
          updatedAt: '2026-09-05T10:00:00.000Z',
        },
      ],
    };
    const snapshot = buildReviewSnapshot({ session, threads: [original], version: 1, cursor: 2 });
    const copied = must(snapshot.threads[0], 'the snapshot carries the one submitted thread');
    expect(copied.resolved).toBe(false);
    snapshot.session.selection.resolvedBase = 'corrupt';
    snapshot.session.limits.timeoutMs = 1;
    copied.position.line = 90;
    must(copied.codeSnapshot, 'the submitted thread carries a code snapshot').content = 'corrupt';
    must(copied.messages[0], 'the submitted thread carries one message').body = 'corrupt';
    expect(session.selection.resolvedBase).toBe('base');
    expect(session.limits.timeoutMs).toBe(3_600_000);
    expect(original).toMatchObject({
      position: { line: { start: 1, end: 2 } },
      codeSnapshot: { content: 'code' },
      messages: [{ body: 'fix' }],
    });
    original.filePath = 'changed';
    expect(copied.filePath).toBe('file.ts');
  });
});
