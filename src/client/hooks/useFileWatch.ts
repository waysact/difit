import { useCallback, useEffect, useRef, useState } from 'react';

import { DiffMode, type ClientWatchState, type WatchEvent } from '../../types/watch.js';
import { resolveEventSourceUrl } from '../utils/eventSourceUrl';

/** Distinguishes a failed comment read from a lost stream, so clearing one cannot hide the other. */
const REFRESH_FAILURE_MESSAGE = 'Lost contact with the server while refreshing comments';

interface FileWatchHook {
  shouldReload: boolean;
  isConnected: boolean;
  error: string | null;
  reload: () => void;
  watchState: ClientWatchState;
}

/**
 * Subscribe to the server's watch stream.
 *
 * `onCommentsChanged` must be referentially stable. It is captured when the connection is opened,
 * and it is now also invoked on connect, on reconnect and when the tab regains focus, so an
 * identity that changes on every render would turn each refresh into another reconnect and refresh.
 */
export function useFileWatch(
  onReload?: () => Promise<void>,
  onCommentsChanged?: () => Promise<void>,
): FileWatchHook {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const refreshAgainRef = useRef(false);
  const maxReconnectAttempts = 5;
  const reconnectDelay = 3000; // 3 seconds

  const [watchState, setWatchState] = useState<ClientWatchState>({
    isWatchEnabled: false,
    diffMode: DiffMode.DEFAULT,
    shouldReload: false,
    isReloading: false,
    lastChangeTime: null,
    lastChangeType: null,
    connectionStatus: 'disconnected',
  });

  const [error, setError] = useState<string | null>(null);

  /**
   * Run one comment refresh at a time and report its failure instead of dropping it. The server
   * broadcasts a comment change and a review change for the same mutation, and a focused tab can
   * ask at the same moment, so a request arriving mid-flight is collapsed into a single repeat
   * rather than a second concurrent read.
   */
  const requestCommentsRefresh = useCallback(() => {
    if (!onCommentsChanged) return;
    if (refreshInFlightRef.current) {
      refreshAgainRef.current = true;
      return;
    }

    refreshInFlightRef.current = true;
    void (async () => {
      try {
        do {
          refreshAgainRef.current = false;
          try {
            await onCommentsChanged();
            setError((current) => (current === REFRESH_FAILURE_MESSAGE ? null : current));
          } catch (refreshError) {
            // A request that arrived during this attempt announced state the attempt never read,
            // so it is still owed a read: fall through to the loop rather than dropping it.
            console.error('Failed to refresh comments after a watch notification:', refreshError);
            setError(REFRESH_FAILURE_MESSAGE);
          }
        } while (refreshAgainRef.current);
      } finally {
        refreshInFlightRef.current = false;
      }
    })();
  }, [onCommentsChanged]);

  const connectToWatch = useCallback(() => {
    if (eventSourceRef.current) {
      return; // Already connected
    }

    // Take ownership of the reconnect slot. Without this an earlier pending retry survives, is
    // overwritten in the ref by the next one, and outlives cleanup to open a stream nobody owns.
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    try {
      const eventSource = new EventSource(resolveEventSourceUrl('/api/watch'));
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('Connected to file watch service');
        setWatchState((prev) => ({
          ...prev,
          connectionStatus: 'connected',
        }));
        reconnectAttemptsRef.current = 0;
        setError(null);
        requestCommentsRefresh();
      };

      eventSource.onmessage = (event) => {
        try {
          // oxlint-disable-next-line typescript/no-unsafe-assignment
          const data: WatchEvent = JSON.parse(event.data as string);

          switch (data.type) {
            case 'connected':
              setWatchState((prev) => ({
                ...prev,
                isWatchEnabled: true,
                diffMode: data.diffMode,
                connectionStatus: 'connected',
              }));
              break;

            case 'reload':
              console.log('File changes detected, showing reload button:', data.changeType);
              setWatchState((prev) => ({
                ...prev,
                shouldReload: true,
                lastChangeTime: new Date(),
                lastChangeType: data.changeType,
              }));
              break;

            case 'error':
              console.error('File watch error:', data.message);
              setError(data.message || 'File watch error occurred');
              break;

            case 'commentsChanged':
            case 'reviewChanged':
              requestCommentsRefresh();
              break;
          }
        } catch (parseError) {
          console.error('Error parsing watch event:', parseError);
        }
      };

      eventSource.onerror = () => {
        console.log('File watch connection lost');
        setWatchState((prev) => ({
          ...prev,
          connectionStatus: 'disconnected',
        }));

        // Close the current connection
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }

        // Attempt to reconnect
        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          setWatchState((prev) => ({
            ...prev,
            connectionStatus: 'reconnecting',
          }));

          reconnectAttemptsRef.current += 1;

          reconnectTimeoutRef.current = setTimeout(() => {
            console.log(
              `Attempting to reconnect to file watch service (${reconnectAttemptsRef.current}/${maxReconnectAttempts})...`,
            );
            // oxlint-disable-next-line react-hooks-js/immutability -- connectToWatch is defined when setTimeout callback runs
            connectToWatch();
          }, reconnectDelay);
        } else {
          console.error('Max reconnection attempts reached');
          setError('Lost connection to file watch service');
        }
      };
    } catch (connectionError) {
      console.error('Failed to connect to file watch service:', connectionError);
      setError('Failed to connect to file watch service');
    }
  }, [maxReconnectAttempts, reconnectDelay, requestCommentsRefresh]);

  const handleReload = useCallback(async () => {
    if (watchState.isReloading) {
      return; // Already reloading
    }

    setWatchState((prev) => ({
      ...prev,
      isReloading: true,
    }));

    try {
      if (onReload) {
        await onReload();
      }

      // Reset reload state after successful reload
      setWatchState((prev) => ({
        ...prev,
        shouldReload: false,
        isReloading: false,
        lastChangeTime: null,
        lastChangeType: null,
      }));
    } catch (reloadError) {
      console.error('Reload failed:', reloadError);
      setError('Failed to reload diff data');

      setWatchState((prev) => ({
        ...prev,
        isReloading: false,
      }));
    }
  }, [onReload, watchState.isReloading]);

  const cleanup = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  };

  // Initialize connection
  useEffect(() => {
    connectToWatch();

    return cleanup;
  }, [connectToWatch]);

  // Cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, []);

  // Returning to the tab is the last line of defence against a missed notification: the hook gives
  // up reconnecting after five attempts, so a sleep longer than that leaves the stream dead with no
  // further onopen to reset it.
  useEffect(() => {
    if (!onCommentsChanged) return undefined;

    const refreshOnAttention = () => {
      if (!eventSourceRef.current) {
        reconnectAttemptsRef.current = 0;
        connectToWatch();
      }
      requestCommentsRefresh();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshOnAttention();
      }
    };

    window.addEventListener('focus', refreshOnAttention);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshOnAttention);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [connectToWatch, onCommentsChanged, requestCommentsRefresh]);

  return {
    shouldReload: watchState.shouldReload,
    isConnected: watchState.connectionStatus === 'connected',
    error,
    reload: handleReload,
    watchState,
  };
}
