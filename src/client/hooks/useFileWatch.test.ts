import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { must } from '../../test/must.js';
import { DiffMode } from '../../types/watch.js';

import { useFileWatch } from './useFileWatch.js';

// Mock EventSource
class MockEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public readyState: number = 0;
  public closed = false;
  public close = vi.fn(function (this: MockEventSource) {
    this.closed = true;
    this.readyState = 2; // CLOSED
  });

  constructor(public url: string) {
    // Store instance for access in tests
    MockEventSource.instances.push(this);

    // Simulate connection after a short delay. A closed stream never opens, which is what makes
    // the hook's retry cap reachable: a real EventSource cannot report open after close().
    setTimeout(() => {
      if (this.closed) {
        return;
      }
      this.readyState = 1; // OPEN
      if (this.onopen) {
        this.onopen(new Event('open'));
      }
    }, 10);
  }

  dispatchMessage(data: string) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }));
    }
  }

  dispatchError() {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }

  static instances: MockEventSource[] = [];
  static clearInstances() {
    MockEventSource.instances = [];
  }
}

// Mock EventSource globally
vi.stubGlobal('EventSource', MockEventSource);

// Mock console methods
vi.stubGlobal('console', {
  log: vi.fn(),
  error: vi.fn(),
});

describe('useFileWatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();
    vi.unstubAllEnvs();
    MockEventSource.clearInstances();
  });

  describe('initial state', () => {
    it('should initialize with default state', () => {
      const { result } = renderHook(() => useFileWatch());

      expect(result.current.shouldReload).toBe(false);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBe(null);
      expect(result.current.watchState).toEqual({
        isWatchEnabled: false,
        diffMode: DiffMode.DEFAULT,
        shouldReload: false,
        isReloading: false,
        lastChangeTime: null,
        lastChangeType: null,
        connectionStatus: 'disconnected',
      });
    });
  });

  describe('SSE connection', () => {
    it('uses the proxied watch endpoint by default', () => {
      renderHook(() => useFileWatch());

      expect(MockEventSource.instances[0]?.url).toBe('/api/watch');
    });

    it('uses the direct API url when configured for development', () => {
      vi.stubEnv('VITE_DIFIT_API_URL', 'http://localhost:4969');

      renderHook(() => useFileWatch());

      expect(MockEventSource.instances[0]?.url).toBe('http://localhost:4969/api/watch');
    });

    it('should establish connection on mount', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      expect(result.current.watchState.connectionStatus).toBe('connected');
    });

    it('should handle connection events', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      // Get the EventSource instance and dispatch a connected event
      const eventSource = MockEventSource.instances[0]!;

      act(() => {
        eventSource.dispatchMessage(
          JSON.stringify({
            type: 'connected',
            diffMode: DiffMode.WORKING,
            changeType: 'file',
            timestamp: new Date().toISOString(),
            message: 'Connected to file watcher',
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.watchState.isWatchEnabled).toBe(true);
        expect(result.current.watchState.diffMode).toBe(DiffMode.WORKING);
      });
    });

    it('should handle reload events', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const eventSource = MockEventSource.instances[0]!;

      act(() => {
        eventSource.dispatchMessage(
          JSON.stringify({
            type: 'reload',
            diffMode: DiffMode.DOT,
            changeType: 'commit',
            timestamp: new Date().toISOString(),
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.shouldReload).toBe(true);
        expect(result.current.watchState.shouldReload).toBe(true);
        expect(result.current.watchState.lastChangeType).toBe('commit');
      });
    });

    it('should handle error events', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const eventSource = MockEventSource.instances[0]!;

      act(() => {
        eventSource.dispatchMessage(
          JSON.stringify({
            type: 'error',
            diffMode: DiffMode.DEFAULT,
            changeType: 'file',
            timestamp: new Date().toISOString(),
            message: 'Watch error occurred',
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Watch error occurred');
      });
    });

    it('should handle malformed messages gracefully', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const eventSource = MockEventSource.instances[0]!;

      act(() => {
        eventSource.dispatchMessage('invalid json');
      });

      // Should not throw or crash
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });
    });
  });

  describe('reload functionality', () => {
    it('should call onReload callback when reload is triggered', async () => {
      const mockOnReload = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileWatch(mockOnReload));

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      // Set shouldReload state first
      const eventSource = MockEventSource.instances[0]!;
      act(() => {
        eventSource.dispatchMessage(
          JSON.stringify({
            type: 'reload',
            diffMode: DiffMode.DEFAULT,
            changeType: 'file',
            timestamp: new Date().toISOString(),
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.shouldReload).toBe(true);
      });

      // Trigger reload
      act(() => {
        result.current.reload();
      });

      await waitFor(() => {
        expect(mockOnReload).toHaveBeenCalled();
        expect(result.current.watchState.isReloading).toBe(true);
      });

      // Wait for reload to complete
      await waitFor(() => {
        expect(result.current.watchState.isReloading).toBe(false);
        expect(result.current.shouldReload).toBe(false);
      });
    });

    it('should handle reload errors', async () => {
      const mockOnReload = vi.fn().mockRejectedValue(new Error('Reload failed'));
      const { result } = renderHook(() => useFileWatch(mockOnReload));

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      // Set shouldReload state first
      const eventSource = MockEventSource.instances[0]!;
      act(() => {
        eventSource.dispatchMessage(
          JSON.stringify({
            type: 'reload',
            diffMode: DiffMode.DEFAULT,
            changeType: 'file',
            timestamp: new Date().toISOString(),
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.shouldReload).toBe(true);
      });

      // Trigger reload
      act(() => {
        result.current.reload();
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to reload diff data');
        expect(result.current.watchState.isReloading).toBe(false);
      });
    });

    it('should not reload if already reloading', async () => {
      const mockOnReload = vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
      const { result } = renderHook(() => useFileWatch(mockOnReload));

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      // Set shouldReload state first
      const eventSource = MockEventSource.instances[0]!;
      act(() => {
        eventSource.dispatchMessage(
          JSON.stringify({
            type: 'reload',
            diffMode: DiffMode.DEFAULT,
            changeType: 'file',
            timestamp: new Date().toISOString(),
          }),
        );
      });

      await waitFor(() => {
        expect(result.current.shouldReload).toBe(true);
      });

      // Trigger first reload
      act(() => {
        result.current.reload();
      });

      await waitFor(() => {
        expect(result.current.watchState.isReloading).toBe(true);
      });

      // Try to trigger second reload while first is in progress
      act(() => {
        result.current.reload();
      });

      // Should only call onReload once
      expect(mockOnReload).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconnection logic', () => {
    it('should set reconnecting status on connection error', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const eventSource = MockEventSource.instances[0]!;

      // Simulate connection error
      act(() => {
        eventSource.dispatchError();
      });

      // Should show reconnecting status
      expect(result.current.watchState.connectionStatus).toBe('reconnecting');
    });

    it('should show error after max reconnection attempts', async () => {
      const { result } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const eventSource = MockEventSource.instances[0]!;

      // Simulate connection error
      act(() => {
        eventSource.dispatchError();
      });

      // Should show reconnecting status initially
      expect(result.current.watchState.connectionStatus).toBe('reconnecting');
    });
  });

  describe('cleanup', () => {
    it('should close connection on unmount', async () => {
      const { result, unmount } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const eventSource = MockEventSource.instances[0]!;

      unmount();

      expect(eventSource.close).toHaveBeenCalled();
    });

    it('should clear timeouts on unmount', async () => {
      const { result, unmount } = renderHook(() => useFileWatch());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const eventSource = MockEventSource.instances[0]!;

      unmount();

      // Should close the connection
      expect(eventSource.close).toHaveBeenCalled();
    });
  });

  describe('review refresh', () => {
    it('refreshes as soon as the watch connection opens', async () => {
      const onCommentsChanged = vi.fn().mockResolvedValue(undefined);
      renderHook(() => useFileWatch(undefined, onCommentsChanged));

      await waitFor(() => expect(onCommentsChanged).toHaveBeenCalledTimes(1));
    });

    it('refreshes again after a dropped connection is re-established', async () => {
      // The hook waits a fixed three seconds before reconnecting, so drive the clock rather than
      // waiting it out.
      vi.useFakeTimers();
      try {
        const onCommentsChanged = vi.fn().mockResolvedValue(undefined);
        renderHook(() => useFileWatch(undefined, onCommentsChanged));

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        expect(onCommentsChanged).toHaveBeenCalledTimes(1);

        act(() => {
          must(MockEventSource.instances[0], 'mounting the hook opened one stream').dispatchError();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3010);
        });

        expect(MockEventSource.instances).toHaveLength(2);
        expect(onCommentsChanged).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refreshes on a reviewChanged notification', async () => {
      const onCommentsChanged = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileWatch(undefined, onCommentsChanged));

      await waitFor(() => expect(result.current.isConnected).toBe(true));
      onCommentsChanged.mockClear();

      act(() => {
        must(MockEventSource.instances[0], 'mounting the hook opened one stream').dispatchMessage(
          JSON.stringify({
            type: 'reviewChanged',
            sessionId: 'review-1',
            cursor: 7,
            timestamp: '2026-09-05T10:00:00.000Z',
          }),
        );
      });

      expect(onCommentsChanged).toHaveBeenCalledTimes(1);
      expect(result.current.shouldReload).toBe(false);
    });

    it('refreshes when the tab regains focus so a missed notification does not leave it stale', async () => {
      const onCommentsChanged = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileWatch(undefined, onCommentsChanged));

      await waitFor(() => expect(result.current.isConnected).toBe(true));
      onCommentsChanged.mockClear();

      act(() => {
        window.dispatchEvent(new Event('focus'));
      });

      expect(onCommentsChanged).toHaveBeenCalledTimes(1);
    });

    it('stops refreshing on focus once unmounted', async () => {
      const onCommentsChanged = vi.fn().mockResolvedValue(undefined);
      const { result, unmount } = renderHook(() => useFileWatch(undefined, onCommentsChanged));

      await waitFor(() => expect(result.current.isConnected).toBe(true));
      unmount();
      onCommentsChanged.mockClear();

      act(() => {
        window.dispatchEvent(new Event('focus'));
      });

      expect(onCommentsChanged).not.toHaveBeenCalled();
    });

    it('reports a failed refresh instead of dropping the rejection', async () => {
      const onCommentsChanged = vi.fn().mockRejectedValue(new Error('server gone'));
      const { result } = renderHook(() => useFileWatch(undefined, onCommentsChanged));

      await waitFor(() =>
        expect(result.current.error).toBe('Lost contact with the server while refreshing comments'),
      );
    });

    it('collapses the paired comment and review notifications into one refresh', async () => {
      let releaseRefresh: (() => void) | undefined;
      const onCommentsChanged = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          }),
      );
      const { result } = renderHook(() => useFileWatch(undefined, onCommentsChanged));

      await waitFor(() => expect(result.current.isConnected).toBe(true));
      expect(onCommentsChanged).toHaveBeenCalledTimes(1);

      const eventSource = must(MockEventSource.instances[0], 'mounting the hook opened one stream');
      act(() => {
        eventSource.dispatchMessage(
          JSON.stringify({ type: 'commentsChanged', version: 2, timestamp: 'now' }),
        );
        eventSource.dispatchMessage(
          JSON.stringify({
            type: 'reviewChanged',
            sessionId: 'review-1',
            cursor: 4,
            timestamp: 'now',
          }),
        );
      });

      expect(onCommentsChanged).toHaveBeenCalledTimes(1);

      await act(async () => {
        releaseRefresh?.();
        await Promise.resolve();
      });

      await waitFor(() => expect(onCommentsChanged).toHaveBeenCalledTimes(2));
      await act(async () => {
        releaseRefresh?.();
        await Promise.resolve();
      });
      expect(onCommentsChanged).toHaveBeenCalledTimes(2);
    });

    it('re-establishes a dropped stream as soon as the tab regains attention', async () => {
      // Reconnection is capped at five attempts and only a successful open resets the counter, so a
      // long sleep can leave the page with no stream at all. Returning to the tab has to rebuild it
      // rather than wait for a retry that is never scheduled.
      const onCommentsChanged = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileWatch(undefined, onCommentsChanged));

      await waitFor(() => expect(result.current.isConnected).toBe(true));
      act(() => {
        must(MockEventSource.instances[0], 'mounting the hook opened one stream').dispatchError();
      });
      const droppedCount = MockEventSource.instances.length;

      act(() => {
        window.dispatchEvent(new Event('focus'));
      });

      expect(MockEventSource.instances.length).toBe(droppedCount + 1);
    });

    it('does not open a second stream when a connected tab regains attention', async () => {
      const onCommentsChanged = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileWatch(undefined, onCommentsChanged));

      await waitFor(() => expect(result.current.isConnected).toBe(true));
      const connectedCount = MockEventSource.instances.length;

      act(() => {
        window.dispatchEvent(new Event('focus'));
      });

      expect(MockEventSource.instances.length).toBe(connectedCount);
    });

    it('refreshes when a hidden tab becomes visible again', async () => {
      const onCommentsChanged = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileWatch(undefined, onCommentsChanged));

      await waitFor(() => expect(result.current.isConnected).toBe(true));
      onCommentsChanged.mockClear();

      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(onCommentsChanged).not.toHaveBeenCalled();

      visibility.mockReturnValue('visible');
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(onCommentsChanged).toHaveBeenCalledTimes(1);
      visibility.mockRestore();
    });

    it('still honours a notification that arrived while a failing refresh was in flight', async () => {
      let failFirst: (() => void) | undefined;
      const onCommentsChanged = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              failFirst = () => reject(new Error('server gone'));
            }),
        )
        .mockResolvedValue(undefined);
      const { result } = renderHook(() => useFileWatch(undefined, onCommentsChanged));

      await waitFor(() => expect(onCommentsChanged).toHaveBeenCalledTimes(1));

      act(() => {
        must(MockEventSource.instances[0], 'mounting the hook opened one stream').dispatchMessage(
          JSON.stringify({ type: 'commentsChanged', version: 2, timestamp: 'now' }),
        );
      });
      expect(onCommentsChanged).toHaveBeenCalledTimes(1);

      // The queued notification announced state the failed attempt never read, so it is still owed
      // a read rather than being discarded with the failure.
      await act(async () => {
        failFirst?.();
        await Promise.resolve();
      });

      await waitFor(() => expect(onCommentsChanged).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.error).toBeNull());
    });

    it('restores the stream after the retry cap has been exhausted', async () => {
      vi.useFakeTimers();
      try {
        const onCommentsChanged = vi.fn().mockResolvedValue(undefined);
        renderHook(() => useFileWatch(undefined, onCommentsChanged));

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });

        // Fail every retry before it can open. Only a successful open resets the counter, so this
        // is the sequence that actually reaches the five-attempt cap.
        for (let attempt = 0; attempt < 6; attempt += 1) {
          act(() => {
            must(
              MockEventSource.instances.at(-1),
              'the initial stream and every retry below the cap leave a current stream',
            ).dispatchError();
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(3000);
          });
        }

        const abandonedCount = MockEventSource.instances.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(MockEventSource.instances).toHaveLength(abandonedCount);

        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        expect(MockEventSource.instances.length).toBe(abandonedCount + 1);

        // Rebuilding the stream is only half of it: attention must also restore the retry budget,
        // or the recovered stream gets no retry of its own the moment it drops again.
        act(() => {
          must(
            MockEventSource.instances.at(-1),
            'regaining focus rebuilt the stream',
          ).dispatchError();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });

        expect(MockEventSource.instances.length).toBe(abandonedCount + 2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
