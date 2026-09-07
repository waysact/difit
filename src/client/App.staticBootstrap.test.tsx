import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { must } from '../test/must.js';
import type { DiffResponse } from '../types/diff';
import { DiffMode } from '../types/watch';

import App from './App';
import { storageService } from './services/StorageService';

// Deliberately NOT mocking useDiffComments: this file exists to exercise the real local comment
// state against the static bootstrap. App.test.tsx mocks it, which makes `replaceThreads` inert and
// hides every defect that depends on the local collection actually changing.
vi.mock('./hooks/useViewport', () => ({
  useViewport: vi.fn(() => ({ isMobile: false, isDesktop: true })),
}));
vi.mock('./hooks/useViewedFiles', () => ({
  useViewedFiles: vi.fn(() => ({
    viewedFiles: new Set<string>(),
    changedSinceViewedFiles: new Set<string>(),
    hasLoadedInitialViewedFiles: true,
    toggleFileViewed: vi.fn(),
    isFileContentChanged: vi.fn(),
    getViewedFileRecord: vi.fn(),
    clearViewedFiles: vi.fn(),
  })),
}));
vi.mock('./hooks/useFileWatch', () => ({
  useFileWatch: vi.fn(() => ({
    shouldReload: false,
    isConnected: true,
    error: null,
    reload: vi.fn(),
    watchState: {
      isWatchEnabled: true,
      diffMode: DiffMode.DEFAULT,
      shouldReload: false,
      isReloading: false,
      lastChangeTime: null,
      lastChangeType: null,
      connectionStatus: 'connected',
    },
  })),
}));

Object.defineProperty(navigator, 'sendBeacon', { writable: true, value: vi.fn() });

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {}
}
Object.defineProperty(window, 'EventSource', { writable: true, value: MockEventSource });

const mockDiffResponse: DiffResponse = {
  commit: 'abc123',
  baseCommitish: 'HEAD^',
  targetCommitish: 'HEAD',
  requestedBaseCommitish: 'HEAD^',
  requestedTargetCommitish: 'HEAD',
  files: [
    {
      path: 'test.ts',
      status: 'modified',
      additions: 5,
      deletions: 2,
      chunks: [
        {
          header: '@@ -10,1 +10,1 @@',
          oldStart: 10,
          oldLines: 1,
          newStart: 10,
          newLines: 1,
          lines: [
            { type: 'normal', content: 'const first = 1;', oldLineNumber: 10, newLineNumber: 10 },
          ],
        },
      ],
    },
  ],
  ignoreWhitespace: false,
  isEmpty: false,
};

const timestamp = '2024-01-01T00:00:00.000Z';
const localThread = {
  id: 'local-1',
  filePath: 'test.ts',
  createdAt: timestamp,
  updatedAt: timestamp,
  position: { side: 'new' as const, line: 10 },
  messages: [
    { id: 'local-1', body: 'Local', author: 'User', createdAt: timestamp, updatedAt: timestamp },
  ],
};

/** Answer after a delay, so a render can happen while the request is outstanding. */
const delayed = <T,>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

const renderApp = () =>
  render(
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      <App />
    </HotkeysProvider>,
  );

describe('static viewer bootstrap against a slow server', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetAllMocks();
  });

  it('writes the merged collection once instead of re-entering while the write is outstanding', async () => {
    storageService.saveCommentThreads('HEAD^', 'HEAD', [localThread], 'abc123');

    let posts = 0;
    let version = 1;
    let serverThreads: unknown[] = [];
    vi.mocked(global.fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith('/api/comments-json')) {
        const snapshot = serverThreads;
        return delayed(50, {
          ok: true,
          json: async () => ({ sessionId: 's', review: null, version, threads: snapshot }),
        } as Response);
      }
      if (url.startsWith('/api/comments')) {
        posts += 1;
        serverThreads = (JSON.parse(String(init?.body)) as { threads: unknown[] }).threads;
        version += 1;
        const snapshot = serverThreads;
        const committed = version;
        return delayed(50, {
          ok: true,
          json: async () => ({ version: committed, threads: snapshot }),
        } as Response);
      }
      if (url === '/api/revisions') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ specialOptions: [], branches: [], commits: [] }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => mockDiffResponse,
        blob: async () => ({ size: 1024 }),
      } as Response);
    });

    renderApp();

    await waitFor(() => expect(posts).toBeGreaterThanOrEqual(1));
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(posts).toBe(1);
  }, 20_000);

  it('keeps a static viewer editable when the bootstrap read fails', async () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    window.localStorage.setItem('difit.diffViewMode', 'unified');
    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith('/api/comments-json')) {
        return Promise.resolve({ ok: false, status: 500, statusText: 'Server Error' } as Response);
      }
      if (url === '/api/revisions') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ specialOptions: [], branches: [], commits: [] }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => mockDiffResponse,
        blob: async () => ({ size: 1024 }),
      } as Response);
    });

    const { container } = renderApp();

    // A failed read must not masquerade as a finished review and lock the viewer out of its own
    // local comments: the line still offers a comment trigger.
    await waitFor(() => {
      expect(container.querySelectorAll('[data-diff-line-row="true"]').length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain('kept in this browser only');
    });

    const rows = container.querySelectorAll('[data-diff-line-row="true"]');
    fireEvent.mouseEnter(must(rows[0], 'the wait above saw at least one line row'));
    expect(screen.getByRole('button', { name: 'Add a comment' })).toBeInTheDocument();

    // It also must not enable the legacy server persistence: a failed read cannot prove this
    // selection is not the launch review, and beaconing a stale collection at it would be
    // destructive.
    expect(addEventListenerSpy.mock.calls.some(([eventName]) => eventName === 'beforeunload')).toBe(
      false,
    );
    addEventListenerSpy.mockRestore();
  }, 20_000);
});
