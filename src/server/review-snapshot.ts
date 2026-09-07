import type { DiffCommentThread } from '../types/diff.js';
import type { ReviewInfo, ReviewSnapshot } from '../types/review.js';

/** Copies the REST boundary so no reader can mutate authoritative review state. */
export function buildReviewSnapshot(input: {
  session: ReviewInfo;
  threads: DiffCommentThread[];
  version: number;
  cursor: number;
}): ReviewSnapshot {
  return structuredClone({
    ...input,
    threads: input.threads.map((thread) => ({ ...thread, resolved: thread.resolved ?? false })),
  });
}
