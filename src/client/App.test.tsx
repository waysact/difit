import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom';

import { mockFetch } from '../../vitest.setup';
import type { DiffCommentThread, DiffResponse } from '../types/diff';
import type { ClientWatchState } from '../types/watch';
import { DiffMode } from '../types/watch';

import App from './App';
import { storageService } from './services/StorageService';
import type { PendingReviewEdit } from './utils/reviewEdits';
import { useDiffComments } from './hooks/useDiffComments';
import { useViewedFiles } from './hooks/useViewedFiles';
import { useViewport } from './hooks/useViewport';
import { useFileWatch } from './hooks/useFileWatch';

// Mock the useViewport hook
vi.mock('./hooks/useViewport', () => ({
  useViewport: vi.fn(() => ({ isMobile: false, isDesktop: true })),
}));

// Mock the useDiffComments hook
vi.mock('./hooks/useDiffComments', () => ({
  useDiffComments: vi.fn(() => ({
    hasLoadedComments: true,
    comments: [],
    threads: mockComments,
    replaceThreads: mockReplaceThreads,
    addComment: vi.fn(),
    addThread: vi.fn(),
    removeComment: vi.fn(),
    removeThread: vi.fn(),
    removeMessage: vi.fn(),
    replyToThread: vi.fn(),
    updateComment: vi.fn(),
    updateMessage: vi.fn(),
    clearAllComments: mockClearAllComments,
    applyCommentImports: mockApplyCommentImports,
    generatePrompt: vi.fn(),
    generateThreadPrompt: vi.fn(() => ''),
    generateAllCommentsPrompt: vi.fn(() => ''),
  })),
}));

// Mock the useViewedFiles hook
const mockClearViewedFiles = vi.fn();
const mockToggleFileViewed = vi.fn();
let mockViewedFiles = new Set<string>();
let mockHasLoadedInitialViewedFiles = true;
vi.mock('./hooks/useViewedFiles', () => ({
  useViewedFiles: vi.fn(() => ({
    viewedFiles: mockViewedFiles,
    changedSinceViewedFiles: new Set<string>(),
    hasLoadedInitialViewedFiles: mockHasLoadedInitialViewedFiles,
    toggleFileViewed: mockToggleFileViewed,
    isFileContentChanged: vi.fn(),
    getViewedFileRecord: vi.fn(),
    clearViewedFiles: mockClearViewedFiles,
  })),
}));

const mockWatchState: ClientWatchState = {
  isWatchEnabled: true,
  diffMode: DiffMode.DEFAULT,
  shouldReload: false,
  isReloading: false,
  lastChangeTime: null,
  lastChangeType: null,
  connectionStatus: 'connected',
};

vi.mock('./hooks/useFileWatch', () => ({
  useFileWatch: vi.fn((onReload?: () => Promise<void>) => ({
    shouldReload: mockWatchState.shouldReload,
    isConnected: true,
    error: null,
    reload: vi.fn(async () => {
      if (onReload) {
        await onReload();
      }
      mockWatchState.shouldReload = false;
      mockWatchState.lastChangeType = null;
    }),
    watchState: mockWatchState,
  })),
}));

// Mock navigator.sendBeacon
Object.defineProperty(navigator, 'sendBeacon', {
  writable: true,
  value: vi.fn(),
});

// Mock the clipboard so the copy handlers' output can be observed
const mockWriteText = vi.fn(async (_text: string) => {});
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: mockWriteText },
});

// Mock window.confirm
const mockConfirm = vi.fn();
Object.defineProperty(window, 'confirm', {
  writable: true,
  value: mockConfirm,
});

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: ((err: any) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  url: string;

  static clearInstances() {
    MockEventSource.instances = [];
  }
}
Object.defineProperty(window, 'EventSource', {
  writable: true,
  value: MockEventSource,
});

let mockComments: DiffCommentThread[] = [];
const mockReplaceThreads = vi.fn();
const mockClearAllComments = vi.fn();
const mockApplyCommentImports = vi.fn(() => []);

function createMockThread({
  id,
  filePath,
  line,
  body,
  author = 'User',
}: {
  id: string;
  filePath: string;
  line: number;
  body: string;
  author?: string;
}): DiffCommentThread {
  const timestamp = '2024-01-01T00:00:00.000Z';
  return {
    id,
    filePath,
    createdAt: timestamp,
    updatedAt: timestamp,
    position: { side: 'new', line },
    messages: [
      {
        id,
        body,
        author,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

// Helper to render App with HotkeysProvider
const renderApp = () => {
  return render(
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      <App />
    </HotkeysProvider>,
  );
};

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllEnvs();
  MockEventSource.clearInstances();
  mockViewedFiles = new Set<string>();
  mockHasLoadedInitialViewedFiles = true;
  mockReplaceThreads.mockReset();
});

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
      chunks: [],
    },
  ],
  ignoreWhitespace: false,
  isEmpty: false,
};

describe('App Component - Clear Comments Functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockApplyCommentImports.mockReset();
    mockApplyCommentImports.mockReturnValue([]);
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
  });

  describe('Copy All Prompt Button', () => {
    it('should generate Copy All Prompt with requested and resolved diff context', async () => {
      mockComments = [
        createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
      ];
      mockFetch({
        ...mockDiffResponse,
        baseCommitish: 'abcdef1',
        targetCommitish: '1234567',
        requestedBaseCommitish: 'main',
        requestedTargetCommitish: 'feature/docs-update',
        requestedBaseMode: 'merge-base',
      });

      renderApp();

      fireEvent.click(await screen.findByText(/Copy All Prompt/));

      // The header carries the requested range, its merge-base separator, and the resolved range.
      await waitFor(() => {
        expect(mockWriteText).toHaveBeenCalledWith(
          expect.stringContaining('diff main...feature/docs-update (abcdef1...1234567)'),
        );
      });
      expect(mockWriteText).toHaveBeenCalledWith(
        expect.stringContaining('test.ts:L10\nTest comment'),
      );
    });
  });

  describe('Cleanup All Prompt Button', () => {
    it('should not show delete button when no comments exist', async () => {
      mockComments = [];

      renderApp();

      await waitFor(() => {
        // Cleanup All Prompt should not be visible without comments (dropdown doesn't exist)
        expect(screen.queryByText('Copy All Prompt')).not.toBeInTheDocument();
        expect(screen.queryByText('Cleanup All Prompt')).not.toBeInTheDocument();
      });
    });

    it('should show delete button when comments exist', async () => {
      mockComments = [
        createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
      ];

      renderApp();

      await waitFor(() => {
        // Find and click the dropdown toggle button (chevron)
        const dropdownToggle = screen.getByTitle('More options');
        fireEvent.click(dropdownToggle);
      });

      await waitFor(() => {
        expect(screen.getByText('Cleanup All Prompt')).toBeInTheDocument();
      });
    });

    it('should call clearAllComments immediately when delete button is clicked', async () => {
      mockComments = [
        createMockThread({ id: '1', filePath: 'test.ts', line: 10, body: 'Comment 1' }),
        createMockThread({ id: '2', filePath: 'test.ts', line: 20, body: 'Comment 2' }),
      ];

      renderApp();

      await waitFor(() => {
        // First, open the dropdown
        const dropdownToggle = screen.getByTitle('More options');
        fireEvent.click(dropdownToggle);
      });

      await waitFor(() => {
        const deleteButton = screen.getByText('Cleanup All Prompt');
        fireEvent.click(deleteButton);
      });

      expect(mockClearAllComments).toHaveBeenCalled();
    });
  });

  describe('Clean flag on Startup', () => {
    it('should clear existing comments when clearComments flag is true in response', async () => {
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).toHaveBeenCalledWith({
          resetAppliedCommentImportIds: true,
        });
      });
    });

    it('should clear viewed files when clearComments flag is true in response', async () => {
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearViewedFiles).toHaveBeenCalled();
      });
    });

    it('should not clear comments when clearComments flag is false', async () => {
      const responseWithoutClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: false,
      };

      mockFetch(responseWithoutClearFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).not.toHaveBeenCalled();
      });
    });

    it('should not clear comments when clearComments flag is undefined', async () => {
      const responseWithoutFlag: DiffResponse = {
        ...mockDiffResponse,
        // clearComments is undefined
      };

      mockFetch(responseWithoutFlag);

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).not.toHaveBeenCalled();
      });
    });

    it('should log message when clearing comments via CLI flag', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      mockFetch(responseWithClearFlag);

      renderApp();

      await waitFor(() => {
        expect(consoleLogSpy).toHaveBeenCalledWith(
          '✅ All existing comments and viewed files cleared as requested via --clean flag',
        );
      });

      consoleLogSpy.mockRestore();
    });

    it('hydrates comments from the server comment session on startup', async () => {
      const serverThreads = [
        createMockThread({
          id: 'imported-thread',
          filePath: 'test.ts',
          line: 10,
          body: 'Imported comment',
        }),
      ];

      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);

        if (url.startsWith('/api/comments-json')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ threads: serverThreads }),
          } as Response);
        }

        if (url.startsWith('/api/comments')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          } as Response);
        }

        if (url === '/api/revisions') {
          return Promise.resolve({
            ok: true,
            json: async () => null,
          } as Response);
        }

        return Promise.resolve({
          ok: true,
          json: async () => mockDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      await waitFor(() => {
        expect(mockReplaceThreads).toHaveBeenCalledWith([{ ...serverThreads[0], resolved: false }]);
      });

      expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
        '/api/comments-json?base=HEAD%5E&target=HEAD',
      );
    });

    it('preserves server-provided comments after clearing local comments on startup', async () => {
      mockComments = [
        createMockThread({
          id: 'stale-local-thread',
          filePath: 'test.ts',
          line: 5,
          body: 'Stale local comment',
        }),
      ];
      const serverThreads = [
        createMockThread({
          id: 'imported-thread',
          filePath: 'test.ts',
          line: 10,
          body: 'Imported comment',
        }),
      ];
      const responseWithClearFlag: DiffResponse = {
        ...mockDiffResponse,
        clearComments: true,
      };

      vi.mocked(global.fetch).mockImplementation((input) => {
        const url = String(input);

        if (url.startsWith('/api/comments-json')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ threads: serverThreads }),
          } as Response);
        }

        if (url.startsWith('/api/comments')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          } as Response);
        }

        if (url === '/api/revisions') {
          return Promise.resolve({
            ok: true,
            json: async () => null,
          } as Response);
        }

        return Promise.resolve({
          ok: true,
          json: async () => responseWithClearFlag,
          blob: async () => ({ size: 1024 }),
        } as Response);
      });

      renderApp();

      await waitFor(() => {
        expect(mockClearAllComments).toHaveBeenCalledWith({
          resetAppliedCommentImportIds: true,
        });
      });

      // Server threads reach the app through the review boundary, which normalizes an absent
      // resolution to false so every consumer of a thread sees the same shape.
      const normalized = serverThreads.map((thread) => ({ ...thread, resolved: false }));

      await waitFor(() => {
        expect(mockReplaceThreads).toHaveBeenCalledWith(normalized);
      });

      expect(mockReplaceThreads).not.toHaveBeenCalledWith([...normalized, ...mockComments]);
    });
  });
});

describe('App Component - Heartbeat Connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
  });

  it('uses the direct API url for heartbeat when configured in development', async () => {
    vi.stubEnv('VITE_DIFIT_API_URL', 'http://localhost:4969');

    renderApp();

    await waitFor(() => {
      expect(MockEventSource.instances[0]?.url).toBe('http://localhost:4969/api/heartbeat');
    });
  });

  it('lets the browser reconnect the heartbeat after a transport error', async () => {
    renderApp();

    await waitFor(() => {
      expect(
        MockEventSource.instances.some((instance) => instance.url.includes('/api/heartbeat')),
      ).toBe(true);
    });

    const heartbeat = MockEventSource.instances.find((instance) =>
      instance.url.includes('/api/heartbeat'),
    );
    expect(heartbeat).toBeDefined();

    // A mock EventSource cannot exhibit the browser's real retry behaviour, so this
    // does not prove a reconnection happens. What it does prove: our error handler no
    // longer calls close(), which is the exact thing that disabled EventSource's
    // built-in retry before this fix; and that, unlike useFileWatch's hand-rolled
    // reconnect for /api/watch (a setTimeout of 3000ms), no replacement EventSource
    // appears even after time well past that delay has elapsed.
    vi.useFakeTimers();
    try {
      heartbeat?.onerror?.(new Event('error'));

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(heartbeat?.close).not.toHaveBeenCalled();
      expect(
        MockEventSource.instances.filter((instance) => instance.url.includes('/api/heartbeat')),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('App Component - Initial file collapsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
    mockViewedFiles = new Set<string>();
    mockHasLoadedInitialViewedFiles = false;
  });

  it('collapses initially viewed files after viewed state finishes loading', async () => {
    const view = renderApp();

    await waitFor(() => {
      expect(screen.getByTitle('Collapse file (Alt+Click to collapse all)')).toBeInTheDocument();
    });

    expect(screen.getByTitle('Collapse file (Alt+Click to collapse all)')).toBeInTheDocument();

    act(() => {
      mockViewedFiles = new Set(['test.ts']);
      mockHasLoadedInitialViewedFiles = true;
      view.rerender(
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <App />
        </HotkeysProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTitle('Expand file (Alt+Click to expand all)')).toBeInTheDocument();
    });
  });
});

describe('App Component - Comment sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(false);
    mockFetch(mockDiffResponse);
  });

  it('syncs an empty comment list after the last comment is resolved', async () => {
    mockComments = [
      createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'Test comment' }),
    ];

    const mockGlobalFetch = vi.mocked(global.fetch);
    const { rerender } = renderApp();

    await waitFor(() => {
      const commentCalls = mockGlobalFetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/comments?'),
      );
      expect(commentCalls).toHaveLength(1);

      const [url, request] = commentCalls[0] as [string, RequestInit];
      expect(url).toBe('/api/comments?base=HEAD%5E&target=HEAD');
      expect(request.method).toBe('POST');
      expect(JSON.parse(String(request.body))).toEqual({
        threads: [
          expect.objectContaining({
            id: 'test-1',
            filePath: 'test.ts',
            position: { side: 'new', line: 10 },
            messages: [
              expect.objectContaining({
                id: 'test-1',
                body: 'Test comment',
                author: 'User',
              }),
            ],
          }),
        ],
      });
    });

    mockComments = [];
    rerender(
      <HotkeysProvider initiallyActiveScopes={['navigation']}>
        <App />
      </HotkeysProvider>,
    );

    await waitFor(() => {
      const commentCalls = mockGlobalFetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/comments?'),
      );
      expect(commentCalls).toHaveLength(2);

      const [url, request] = commentCalls[1] as [string, RequestInit];
      expect(url).toBe('/api/comments?base=HEAD%5E&target=HEAD');
      expect(request.method).toBe('POST');
      expect(JSON.parse(String(request.body))).toEqual({ threads: [] });
    });
  });

  it('sends an empty comment list on unload when no comments remain', async () => {
    mockComments = [];
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    renderApp();

    await waitFor(() => {
      expect(addEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    });

    const beforeUnloadHandler = addEventListenerSpy.mock.calls.find(
      ([eventName]) => eventName === 'beforeunload',
    )?.[1] as (() => void) | undefined;
    expect(beforeUnloadHandler).toBeDefined();
    beforeUnloadHandler?.();

    expect(navigator.sendBeacon).toHaveBeenCalledWith(
      '/api/comments?base=HEAD%5E&target=HEAD',
      JSON.stringify({ threads: [] }),
    );
    addEventListenerSpy.mockRestore();
  });

  it('sends the last read version with a static sync and adopts a merged result', async () => {
    mockComments = [
      createMockThread({ id: 'local-1', filePath: 'test.ts', line: 10, body: 'Local comment' }),
    ];
    const agentThread = {
      ...createMockThread({ id: 'agent-1', filePath: 'test.ts', line: 20, body: 'Agent comment' }),
      resolved: false,
    };
    const writes: { threads: DiffCommentThread[]; baseVersion?: number }[] = [];
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    vi.mocked(global.fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith('/api/comments-json')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ review: null, version: 7, threads: [] }),
        } as Response);
      }
      if (url.startsWith('/api/comments')) {
        const body = JSON.parse(String(init?.body)) as (typeof writes)[number];
        writes.push(body);
        // The server saw another writer since version 7, so it merged rather than replaced.
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            merged: true,
            version: 8,
            threads: [...body.threads, agentThread],
          }),
        } as Response);
      }
      if (url === '/api/revisions') {
        return Promise.resolve({ ok: true, json: async () => null } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => mockDiffResponse,
        blob: async () => ({ size: 1024 }),
      } as Response);
    });

    renderApp();

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      baseVersion: 7,
      threads: [expect.objectContaining({ id: 'local-1' })],
    });

    // A merged answer is adopted so the next write does not push the stale local set back.
    await waitFor(() => {
      expect(mockReplaceThreads).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: 'local-1' }),
        agentThread,
      ]);
    });
    expect(writes).toHaveLength(1);

    // The unload beacon reports the version the merged answer carried.
    const beforeUnloadHandler = addEventListenerSpy.mock.calls
      .filter(([eventName]) => eventName === 'beforeunload')
      .at(-1)?.[1] as (() => void) | undefined;
    expect(beforeUnloadHandler).toBeDefined();
    beforeUnloadHandler?.();
    const beacon = vi.mocked(navigator.sendBeacon).mock.lastCall;
    expect(beacon?.[0]).toBe('/api/comments?base=HEAD%5E&target=HEAD');
    expect(JSON.parse(String(beacon?.[1]))).toMatchObject({ baseVersion: 8 });
    addEventListenerSpy.mockRestore();
  });

  it('shows author badges in the comments modal when the diff has multiple authors', async () => {
    mockComments = [
      createMockThread({ id: 'test-1', filePath: 'test.ts', line: 10, body: 'User comment' }),
      createMockThread({
        id: 'test-2',
        filePath: 'other.ts',
        line: 20,
        body: 'Reviewer comment',
        author: 'Reviewer',
      }),
    ];
    mockFetch({
      ...mockDiffResponse,
      files: [
        ...mockDiffResponse.files,
        {
          path: 'other.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          chunks: [],
        },
      ],
    });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await screen.findByText('User')).toBeInTheDocument();
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
  });
});

describe('App Component - Diff Mode Persistence', () => {
  it('initializes the selected view mode from localStorage', async () => {
    mockFetch(mockDiffResponse);
    window.localStorage.setItem('difit.diffViewMode', 'unified');

    renderApp();

    const unifiedButton = await screen.findByRole('button', { name: 'Unified' });

    await waitFor(() => {
      expect(unifiedButton).toHaveClass('bg-github-bg-primary');
    });
  });

  it('persists the selected view mode to localStorage', async () => {
    mockFetch(mockDiffResponse);

    renderApp();

    const unifiedButton = await screen.findByRole('button', { name: 'Unified' });
    fireEvent.click(unifiedButton);

    expect(window.localStorage.getItem('difit.diffViewMode')).toBe('unified');
  });

  it('keeps the selected view mode after triggering refresh', async () => {
    const mockGlobalFetch = vi.mocked(global.fetch);
    mockGlobalFetch.mockClear();
    mockComments = [];
    mockClearAllComments.mockReset();
    mockConfirm.mockReturnValue(false);
    mockWatchState.shouldReload = true;
    mockWatchState.lastChangeType = 'file';
    mockFetch(mockDiffResponse);

    renderApp();

    const unifiedButton = await screen.findByRole('button', { name: 'Unified' });
    fireEvent.click(unifiedButton);

    await waitFor(() => {
      expect(unifiedButton).toHaveClass('bg-github-bg-primary');
    });

    const refreshButton = await screen.findByRole('button', { name: 'Refresh' });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      // 4 calls: initial /api/diff, /api/revisions, initial /api/comments sync, and refresh /api/diff
      expect(mockGlobalFetch).toHaveBeenCalledTimes(4);
    });

    await waitFor(() => {
      expect(unifiedButton).toHaveClass('bg-github-bg-primary');
    });
    mockWatchState.shouldReload = false;
    mockWatchState.lastChangeType = null;
  });
});

describe('App Component - Merge-base selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
  });

  it('clears the resolved base revision after switching to a merge-base quick diff', async () => {
    const initialDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '88aabb0',
      targetCommitish: '.',
      requestedBaseCommitish: 'HEAD',
      requestedTargetCommitish: '.',
    };
    const mergeBaseDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1122334',
      targetCommitish: '.',
      requestedBaseCommitish: 'origin/main',
      requestedTargetCommitish: '.',
      requestedBaseMode: 'merge-base',
    };
    const revisionsResponse = {
      specialOptions: [{ value: '.', label: 'All Uncommitted Changes' }],
      branches: [],
      commits: [
        {
          hash: '88aabb0fffff1111222233334444555566667777',
          shortHash: '88aabb0',
          message: 'stale direct base',
        },
        {
          hash: '1122334fffff1111222233334444555566667777',
          shortHash: '1122334',
          message: 'merge base',
        },
      ],
      originDefaultBranch: 'origin/main',
    };

    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);

      if (url.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: async () => revisionsResponse,
        } as Response);
      }

      if (url.includes('/api/diff')) {
        const response =
          url.includes('base=origin%2Fmain') && url.includes('baseMode=merge-base')
            ? mergeBaseDiffResponse
            : initialDiffResponse;

        return Promise.resolve({
          ok: true,
          json: async () => response,
          blob: async () => ({ size: 1024 }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'origin/main...Uncommitted (merge-base)' }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Revision menu: origin/main...Uncommitted Changes (merge-base)',
        }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole('button', {
        name: 'Revision menu: 88aabb0...Uncommitted Changes (merge-base)',
      }),
    ).not.toBeInTheDocument();
  });

  it('uses resolved revisions for persisted diff state identity', async () => {
    const response: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1234567',
      targetCommitish: '98664e1',
      requestedBaseCommitish: '98664e1^',
      requestedTargetCommitish: '98664e1',
    };

    mockFetch(response);

    renderApp();

    await waitFor(() => {
      expect(vi.mocked(useDiffComments)).toHaveBeenCalledWith(
        '1234567',
        '98664e1',
        'abc123',
        undefined,
        undefined,
        undefined,
      );
    });

    expect(vi.mocked(useViewedFiles)).toHaveBeenCalledWith(
      '1234567',
      '98664e1',
      'abc123',
      undefined,
      response.files,
      undefined,
      [],
      undefined,
    );
  });

  it('ignores stale resolvedBase from /api/revisions on initial merge-base load', async () => {
    const mergeBaseDiffResponse: DiffResponse = {
      ...mockDiffResponse,
      baseCommitish: '1122334',
      targetCommitish: '.',
      requestedBaseCommitish: 'origin/main',
      requestedTargetCommitish: '.',
      requestedBaseMode: 'merge-base',
    };
    const revisionsResponse = {
      specialOptions: [{ value: '.', label: 'All Uncommitted Changes' }],
      branches: [],
      commits: [
        {
          hash: '88aabb0fffff1111222233334444555566667777',
          shortHash: '88aabb0',
          message: 'stale direct base',
        },
      ],
      originDefaultBranch: 'origin/main',
      resolvedBase: '88aabb0',
      resolvedTarget: '1122334',
    };

    let resolveRevisions: (() => void) | null = null;

    vi.mocked(global.fetch).mockImplementation((input) => {
      const url = String(input);

      if (url.includes('/api/revisions')) {
        return new Promise<Response>((resolve) => {
          resolveRevisions = () =>
            resolve({
              ok: true,
              json: async () => revisionsResponse,
            } as Response);
        });
      }

      if (url.includes('/api/diff')) {
        return Promise.resolve({
          ok: true,
          json: async () => mergeBaseDiffResponse,
          blob: async () => ({ size: 1024 }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Reviewing:')).toBeInTheDocument();
    });

    await act(async () => {
      resolveRevisions?.();
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Revision menu: origin/main...Uncommitted Changes (merge-base)',
        }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole('button', {
        name: 'Revision menu: 88aabb0...Uncommitted Changes (merge-base)',
      }),
    ).not.toBeInTheDocument();
  });
});

describe('App Component - Revision-aware refetching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
  });

  it('keeps the selected revisions when refetching without explicit revision params', async () => {
    const diffResponse: DiffResponse = {
      ...mockDiffResponse,
      requestedBaseCommitish: 'HEAD^',
      requestedTargetCommitish: 'HEAD',
    };

    vi.mocked(global.fetch).mockImplementation((input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('/api/revisions')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            specialOptions: [],
            branches: [],
            commits: [
              {
                hash: 'abc1234',
                shortHash: 'abc1234',
                message: 'Test commit',
              },
            ],
          }),
        } as Response);
      }

      if (url.startsWith('/api/comments?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => diffResponse,
        blob: async () => ({ size: 1024 }),
      } as Response);
    });

    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /Revision menu:/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Previous commit' }));

    await waitFor(() => {
      const diffCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter(([url]) => typeof url === 'string' && url.startsWith('/api/diff'));
      expect(diffCalls).toHaveLength(2);
      expect(String(diffCalls[1]?.[0])).toContain('base=HEAD%5E%5E');
      expect(String(diffCalls[1]?.[0])).toContain('target=HEAD%5E');
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Ignore Whitespace' }));

    await waitFor(() => {
      const diffCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter(([url]) => typeof url === 'string' && url.startsWith('/api/diff'));
      expect(diffCalls).toHaveLength(3);
      expect(String(diffCalls[2]?.[0])).toContain('base=HEAD%5E%5E');
      expect(String(diffCalls[2]?.[0])).toContain('target=HEAD%5E');
    });
  });
});

describe('App Component - Sidebar persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
    mockFetch(mockDiffResponse);
  });

  it('restores file tree open state from localStorage', async () => {
    window.localStorage.setItem('difit.sidebarOpen', 'false');

    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('persists file tree open state when toggled', async () => {
    renderApp();

    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });

    fireEvent.click(toggleButton);
    await waitFor(() => {
      expect(window.localStorage.getItem('difit.sidebarOpen')).toBe('false');
    });

    fireEvent.click(toggleButton);
    await waitFor(() => {
      expect(window.localStorage.getItem('difit.sidebarOpen')).toBe('true');
    });
  });
});

describe('App Component - Mobile sidebar auto-close', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(false);
    vi.mocked(useViewport).mockReturnValue({ isMobile: true, isDesktop: false });
  });

  afterEach(() => {
    vi.mocked(useViewport).mockReturnValue({ isMobile: false, isDesktop: true });
  });

  it('closes the sidebar when a file is selected on mobile', async () => {
    mockFetch(mockDiffResponse);
    renderApp();

    // Sidebar toggle button
    const toggleButton = await screen.findByRole('button', { name: /toggle file tree panel/i });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');

    // Wait for file list to render, then click the file row
    const fileRow = await screen.findByTitle('test.ts');
    fireEvent.click(fileRow.closest('[data-file-row]')!);

    // Sidebar should now be closed on mobile
    await waitFor(() => {
      expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    });
  });
});

describe('App Component - Selected review', () => {
  const reviewSession = {
    sessionId: 'review-1',
    selectionKey: 'HEAD^...HEAD',
    selection: {
      requestedBase: 'HEAD^',
      requestedTarget: 'HEAD',
      resolvedBase: 'HEAD^',
      resolvedTarget: 'HEAD',
      baseMode: 'direct',
    },
    publicUrl: 'http://localhost:4966',
    apiUrl: 'http://localhost:4966',
    port: 4966,
    pid: 1,
    state: 'active',
    reason: null,
    cursor: 3,
    finishedCursor: null,
    finishedAt: null,
    cleanupAt: null,
    limits: { idleGraceMs: 10_000, timeoutMs: 3_600_000, cleanupGraceMs: 300_000 },
  };
  const serverThread = {
    ...createMockThread({ id: 'server-1', filePath: 'test.ts', line: 10, body: 'Server comment' }),
    resolved: false,
  };

  /** Answer the selected-review bootstrap read; everything else keeps the ordinary diff response. */
  const mockReviewFetch = ({
    review,
    threads,
    onWrite,
  }: {
    review: Record<string, unknown> | null;
    threads: unknown[];
    onWrite?: (body: unknown) => Response;
  }) => {
    vi.mocked(global.fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith('/api/comments-json')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'review-1', review, version: 1, threads }),
        } as Response);
      }
      if (url.startsWith('/api/comments')) {
        return Promise.resolve(
          onWrite?.(JSON.parse(String(init?.body))) ??
            ({ ok: true, json: async () => ({ version: 2, threads }) } as Response),
        );
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockComments = [];
    mockConfirm.mockReturnValue(true);
  });

  it('renders the review server threads rather than local comments', async () => {
    mockComments = [
      createMockThread({ id: 'local-only', filePath: 'test.ts', line: 99, body: 'Local only' }),
    ];
    mockReviewFetch({ review: reviewSession, threads: [serverThread] });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await screen.findByText('Server comment')).toBeInTheDocument();
    expect(screen.queryByText('Local only')).not.toBeInTheDocument();
  });

  it('copies the displayed thread prompt in review mode', async () => {
    mockReviewFetch({ review: reviewSession, threads: [serverThread] });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));
    fireEvent.click(await screen.findByTitle('Copy thread prompt for AI coding agent'));

    await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(1));
    expect(mockWriteText).toHaveBeenCalledWith(
      expect.stringContaining('test.ts:L10\nServer comment'),
    );
  });

  it('copies every displayed thread prompt in review mode', async () => {
    mockReviewFetch({ review: reviewSession, threads: [serverThread] });

    renderApp();

    fireEvent.click(await screen.findByText(/Copy All Prompt/));

    await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(1));
    expect(mockWriteText).toHaveBeenCalledWith(
      expect.stringContaining('test.ts:L10\nServer comment'),
    );
  });

  it('says the server could not be reached when a later read fails on a live review', async () => {
    mockReviewFetch({ review: reviewSession, threads: [serverThread] });

    renderApp();
    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));
    expect(await screen.findByText('Server comment')).toBeInTheDocument();
    expect(screen.queryByText(/Could not reach/)).not.toBeInTheDocument();

    const diffFetch = vi.mocked(global.fetch).getMockImplementation();
    if (diffFetch === undefined) {
      throw new Error('renderApp installs the fetch mock this test layers a failure onto');
    }
    vi.mocked(global.fetch).mockImplementation((input, init) => {
      if (String(input).startsWith('/api/comments-json')) {
        return Promise.resolve({ ok: false, status: 502, statusText: 'Bad Gateway' } as Response);
      }
      return diffFetch(input, init);
    });
    const onCommentsChanged = vi.mocked(useFileWatch).mock.lastCall?.[1];
    if (onCommentsChanged === undefined) {
      throw new Error('App passes onCommentsChanged to useFileWatch once a review is selected');
    }
    await act(async () => {
      await expect(onCommentsChanged()).rejects.toThrow('502');
    });

    expect(
      await screen.findByText(
        /Could not reach the review server\. What is shown may be out of date/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Review input closed/)).not.toBeInTheDocument();
    expect(screen.getByText('Server comment')).toBeInTheDocument();
  });

  it('marks a resolved thread and does not hide it', async () => {
    mockReviewFetch({ review: reviewSession, threads: [{ ...serverThread, resolved: true }] });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await screen.findByText('Server comment')).toBeInTheDocument();
    expect(screen.getAllByText('Resolved').length).toBeGreaterThan(0);
  });

  it('closes input and explains why once the review has finished', async () => {
    mockReviewFetch({
      review: {
        ...reviewSession,
        state: 'finished',
        reason: 'review_timeout',
        finishedCursor: 4,
        finishedAt: '2026-09-05T10:05:00.000Z',
      },
      threads: [serverThread],
    });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await screen.findByText('Server comment')).toBeInTheDocument();
    expect(
      screen.getAllByText(/Review input closed: the review reached its time limit/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('Write a reply...')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });

  it('keeps a rejected change visible with retry and discard rather than claiming it saved', async () => {
    mockReviewFetch({
      review: reviewSession,
      threads: [serverThread],
      onWrite: () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({ error: { code: 'version_conflict' } }),
        }) as Response,
    });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve thread' }));

    expect(await screen.findByText('Review conflict')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeInTheDocument();
  });

  it('leaves a static viewer with no review session on its local behavior', async () => {
    mockComments = [
      createMockThread({ id: 'local-only', filePath: 'test.ts', line: 99, body: 'Local only' }),
    ];
    mockReviewFetch({ review: null, threads: [] });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await screen.findByText('Local only')).toBeInTheDocument();
  });

  it('does not tell the user an active review ended when an earlier draft is waiting', async () => {
    const earlier: PendingReviewEdit[] = [
      {
        kind: 'setResolved',
        threadId: serverThread.id,
        before: false,
        resolved: true,
        updatedAt: '2026-09-05T10:01:00.000Z',
      },
    ];
    storageService.saveReviewDraft('review-0', 'default:HEAD^:HEAD:direct', earlier);
    mockReviewFetch({ review: reviewSession, threads: [serverThread] });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await screen.findByText('Server comment')).toBeInTheDocument();
    expect(
      screen.getAllByText(/work from an earlier review of these revisions is still waiting/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/no longer active/)).not.toBeInTheDocument();
    expect(screen.queryByText(/reached its time limit/)).not.toBeInTheDocument();
  });

  it('renders a review whose stored draft is corrupt instead of crashing', async () => {
    // Written by hand rather than through saveReviewDraft: the point is a draft no current build
    // would produce, left behind by an older one or a damaged store.
    window.localStorage.setItem(
      `difit-review-draft-v1/review-1/${encodeURIComponent('default:HEAD^:HEAD:direct')}`,
      JSON.stringify([{ kind: 'createThread', thread: { id: 'x' } }]),
    );
    mockReviewFetch({ review: reviewSession, threads: [serverThread] });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));

    expect(await screen.findByText('Server comment')).toBeInTheDocument();
    expect(console.error).toHaveBeenCalledWith(
      'Invalid review draft in localStorage: unrecognized or incomplete edit',
    );
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
  });

  it('offers to discard a stored edit the page cannot replay instead of crashing', async () => {
    // Bypass the storage check to prove the render itself survives an edit it cannot replay.
    const shapeless = [
      { kind: 'createThread', thread: { id: 'x' } },
    ] as unknown as PendingReviewEdit[];
    const getReviewDraft = vi.spyOn(storageService, 'getReviewDraft').mockReturnValue(shapeless);
    mockReviewFetch({ review: reviewSession, threads: [serverThread] });

    try {
      renderApp();

      fireEvent.click(await screen.findByTitle('More options'));
      fireEvent.click(await screen.findByText('View All Comments'));

      expect(await screen.findByText('Server comment')).toBeInTheDocument();
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
    } finally {
      getReviewDraft.mockRestore();
    }
  });

  it('warns before unload while review work is still queued', async () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    mockReviewFetch({
      review: reviewSession,
      threads: [serverThread],
      onWrite: () => ({ ok: false, status: 409, json: async () => ({}) }) as Response,
    });

    renderApp();

    fireEvent.click(await screen.findByTitle('More options'));
    fireEvent.click(await screen.findByText('View All Comments'));
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve thread' }));
    await screen.findByText('Review conflict');

    const handler = addEventListenerSpy.mock.calls.find(
      ([eventName]) => eventName === 'beforeunload',
    )?.[1] as ((event: BeforeUnloadEvent) => void) | undefined;
    expect(handler).toBeDefined();

    const event = {
      preventDefault: vi.fn(),
      returnValue: undefined,
    } as unknown as BeforeUnloadEvent;
    handler?.(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe('');
    addEventListenerSpy.mockRestore();
  });
});
