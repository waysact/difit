import { describe, expect, it } from 'vitest';

import type { DiffCommentMessage } from '../../types/diff';
import type { ReviewThread } from '../../types/review';

import { applyReviewEdits, type PendingReviewEdit } from './reviewEdits';

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

const agentReply: DiffCommentMessage = {
  id: 'a1',
  body: 'Working on it',
  author: 'Agent',
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
};

describe('applyReviewEdits', () => {
  it('preserves an agent reply added after a user began editing another message', () => {
    const result = applyReviewEdits(
      [{ ...thread, messages: [...thread.messages, agentReply] }],
      [
        {
          kind: 'editMessage',
          threadId: thread.id,
          before: firstMessage,
          body: 'Please fix this before merging',
          updatedAt: '2026-09-05T10:01:00.000Z',
        },
      ],
    );

    expect(result).toEqual({
      ok: true,
      threads: [
        {
          ...thread,
          updatedAt: '2026-09-05T10:01:00.000Z',
          messages: [
            {
              ...firstMessage,
              body: 'Please fix this before merging',
              updatedAt: '2026-09-05T10:01:00.000Z',
            },
            agentReply,
          ],
        },
      ],
    });
  });

  it('conflicts when deleting the whole old thread after an agent reply exists', () => {
    const current = [{ ...thread, messages: [...thread.messages, agentReply] }];

    expect(applyReviewEdits(current, [{ kind: 'deleteThread', before: thread }])).toEqual({
      ok: false,
      conflictIndex: 0,
    });
  });

  it('does not reapply an already acknowledged message edit', () => {
    expect(
      applyReviewEdits(
        [
          {
            ...thread,
            updatedAt: '2026-09-05T10:01:00.000Z',
            messages: [
              {
                ...firstMessage,
                body: 'Please fix this before merging',
                updatedAt: '2026-09-05T10:01:00.000Z',
              },
            ],
          },
        ],
        [
          {
            kind: 'editMessage',
            threadId: thread.id,
            before: firstMessage,
            body: 'Please fix this before merging',
            updatedAt: '2026-09-05T10:01:00.000Z',
          },
        ],
      ),
    ).toEqual({
      ok: true,
      threads: [
        {
          ...thread,
          updatedAt: '2026-09-05T10:01:00.000Z',
          messages: [
            {
              ...firstMessage,
              body: 'Please fix this before merging',
              updatedAt: '2026-09-05T10:01:00.000Z',
            },
          ],
        },
      ],
    });
  });

  it('deletes one message without disturbing an unrelated agent reply', () => {
    const userReply: DiffCommentMessage = {
      id: 'm2',
      body: 'Second thought',
      author: 'User',
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
    const current = [{ ...thread, messages: [...thread.messages, userReply, agentReply] }];

    expect(
      applyReviewEdits(current, [
        { kind: 'deleteMessage', threadId: thread.id, before: userReply },
      ]),
    ).toEqual({
      ok: true,
      threads: [{ ...thread, messages: [firstMessage, agentReply] }],
    });
  });

  it('conflicts when the message to delete changed under the user', () => {
    const current = [
      {
        ...thread,
        messages: [{ ...firstMessage, body: 'Rewritten elsewhere' }],
      },
    ];

    expect(
      applyReviewEdits(current, [
        { kind: 'deleteMessage', threadId: thread.id, before: firstMessage },
      ]),
    ).toEqual({ ok: false, conflictIndex: 0 });
  });

  it('treats a thread that is already gone as deleted rather than a conflict', () => {
    expect(applyReviewEdits([], [{ kind: 'deleteThread', before: thread }])).toEqual({
      ok: true,
      threads: [],
    });
  });

  it('deletes an unchanged thread and leaves the remaining collection empty', () => {
    expect(applyReviewEdits([thread], [{ kind: 'deleteThread', before: thread }])).toEqual({
      ok: true,
      threads: [],
    });
  });

  it('applies a resolution and rejects one whose prior value moved elsewhere', () => {
    expect(
      applyReviewEdits(
        [thread],
        [
          {
            kind: 'setResolved',
            threadId: thread.id,
            before: false,
            resolved: true,
            updatedAt: '2026-09-05T10:01:00.000Z',
          },
        ],
      ),
    ).toEqual({
      ok: true,
      threads: [{ ...thread, resolved: true, updatedAt: '2026-09-05T10:01:00.000Z' }],
    });

    expect(
      applyReviewEdits(
        [{ ...thread, resolved: true }],
        [
          {
            kind: 'setResolved',
            threadId: thread.id,
            before: false,
            resolved: false,
            updatedAt: '2026-09-05T10:01:00.000Z',
          },
        ],
      ),
    ).toEqual({ ok: false, conflictIndex: 0 });
  });

  it('accepts a resolution the server already recorded with the same outcome', () => {
    expect(
      applyReviewEdits(
        [{ ...thread, resolved: true }],
        [
          {
            kind: 'setResolved',
            threadId: thread.id,
            before: false,
            resolved: true,
            updatedAt: '2026-09-05T10:01:00.000Z',
          },
        ],
      ),
    ).toEqual({ ok: true, threads: [{ ...thread, resolved: true }] });
  });

  it('conflicts when a reply targets a thread the agent removed', () => {
    expect(
      applyReviewEdits([], [{ kind: 'reply', threadId: thread.id, message: agentReply }]),
    ).toEqual({ ok: false, conflictIndex: 0 });
  });

  it('conflicts on a duplicate id whose content differs', () => {
    const current = [thread, { ...thread, filePath: 'other.ts' }];

    expect(
      applyReviewEdits(current, [
        {
          kind: 'setResolved',
          threadId: thread.id,
          before: false,
          resolved: true,
          updatedAt: thread.updatedAt,
        },
      ]),
    ).toEqual({ ok: false, conflictIndex: 0 });
  });

  it('reports the index of the edit that conflicted, not the first of the batch', () => {
    const current = [{ ...thread, messages: [...thread.messages, agentReply] }];

    expect(
      applyReviewEdits(current, [
        {
          kind: 'reply',
          threadId: thread.id,
          message: {
            id: 'u2',
            body: 'Thanks',
            author: 'User',
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
          },
        },
        { kind: 'deleteThread', before: thread },
      ]),
    ).toEqual({ ok: false, conflictIndex: 1 });
  });

  it('applies nothing to an empty collection when there is nothing queued', () => {
    expect(applyReviewEdits([], [])).toEqual({ ok: true, threads: [] });
  });

  it('does not mutate the acknowledged snapshot it was given', () => {
    const current = [thread];
    const snapshot = JSON.stringify(current);

    applyReviewEdits(current, [
      {
        kind: 'editMessage',
        threadId: thread.id,
        before: firstMessage,
        body: 'Changed',
        updatedAt: '2026-09-05T10:01:00.000Z',
      },
    ]);

    expect(JSON.stringify(current)).toBe(snapshot);
  });

  it('does not treat a locally captured undefined optional as a change the server made', () => {
    const localCapture = { ...thread, codeSnapshot: undefined };

    expect(applyReviewEdits([thread], [{ kind: 'deleteThread', before: localCapture }])).toEqual({
      ok: true,
      threads: [],
    });
  });

  it('accepts a created thread the agent has since replied to', () => {
    const current = [{ ...thread, messages: [...thread.messages, agentReply] }];

    expect(applyReviewEdits(current, [{ kind: 'createThread', thread }])).toEqual({
      ok: true,
      threads: current,
    });
  });

  it('conflicts when a created thread lost the message it was created with', () => {
    const current = [{ ...thread, messages: [agentReply] }];

    expect(applyReviewEdits(current, [{ kind: 'createThread', thread }])).toEqual({
      ok: false,
      conflictIndex: 0,
    });
  });

  it('reports a structurally invalid edit as a conflict at its index instead of throwing', () => {
    // A stored draft outlives the build that wrote it, so an entry can arrive with the tag intact
    // and the fields the replay reads through missing.
    const shapeless = { kind: 'createThread', thread: { id: 'x' } } as unknown as PendingReviewEdit;
    const reply: PendingReviewEdit = {
      kind: 'reply',
      threadId: thread.id,
      message: { ...agentReply, id: 'u2', author: 'User' },
    };

    expect(applyReviewEdits([thread], [shapeless])).toEqual({ ok: false, conflictIndex: 0 });
    expect(applyReviewEdits([thread], [reply, shapeless])).toEqual({ ok: false, conflictIndex: 1 });
  });

  it('reports an edit whose payload is null as a conflict instead of throwing', () => {
    const nullMessage = { kind: 'reply', threadId: thread.id, message: null };
    const nullBefore = { kind: 'deleteThread', before: null };

    expect(applyReviewEdits([thread], [nullMessage as unknown as PendingReviewEdit])).toEqual({
      ok: false,
      conflictIndex: 0,
    });
    expect(applyReviewEdits([thread], [nullBefore as unknown as PendingReviewEdit])).toEqual({
      ok: false,
      conflictIndex: 0,
    });
  });
});
