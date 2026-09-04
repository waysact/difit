import { describe, expect, it } from 'vitest';

import { ReviewLifecycle } from './review-lifecycle.js';

const t = (ms: number): Date => new Date(1_700_000_000_000 + ms);

describe('ReviewLifecycle', () => {
  it('starts in waiting with no clients', () => {
    const lifecycle = new ReviewLifecycle(10_000);

    expect(lifecycle.stateAt(t(0))).toEqual({
      status: 'waiting',
      terminal: false,
      clients: 0,
      disconnects: 0,
      idleSince: null,
    });
  });

  it('stays in waiting forever until the first client connects', () => {
    const lifecycle = new ReviewLifecycle(10_000);

    expect(lifecycle.stateAt(t(3_600_000)).status).toBe('waiting');
    expect(lifecycle.stateAt(t(3_600_000)).terminal).toBe(false);
  });

  it('is reviewing while a client is connected', () => {
    const lifecycle = new ReviewLifecycle(10_000);
    lifecycle.onConnect(t(0));

    expect(lifecycle.stateAt(t(60_000)).status).toBe('reviewing');
    expect(lifecycle.stateAt(t(60_000)).clients).toBe(1);
  });

  it('stays reviewing inside the grace period after the last disconnect', () => {
    const lifecycle = new ReviewLifecycle(10_000);
    lifecycle.onConnect(t(0));
    lifecycle.onDisconnect(t(1_000));

    expect(lifecycle.stateAt(t(10_999)).status).toBe('reviewing');
    expect(lifecycle.stateAt(t(10_999)).terminal).toBe(false);
    expect(lifecycle.stateAt(t(10_999)).idleSince).toEqual(t(1_000));
  });

  it('becomes idle and terminal once the grace period elapses', () => {
    const lifecycle = new ReviewLifecycle(10_000);
    lifecycle.onConnect(t(0));
    lifecycle.onDisconnect(t(1_000));

    expect(lifecycle.stateAt(t(11_000))).toEqual({
      status: 'idle',
      terminal: true,
      clients: 0,
      disconnects: 1,
      idleSince: t(1_000),
    });
  });

  it('returns to reviewing when a client reconnects inside the grace period', () => {
    const lifecycle = new ReviewLifecycle(10_000);
    lifecycle.onConnect(t(0));
    lifecycle.onDisconnect(t(1_000));
    lifecycle.onConnect(t(4_000));

    const state = lifecycle.stateAt(t(20_000));
    expect(state.status).toBe('reviewing');
    expect(state.idleSince).toBeNull();
    expect(state.disconnects).toBe(1);
  });

  it('does not go idle while a second tab is still open', () => {
    const lifecycle = new ReviewLifecycle(10_000);
    lifecycle.onConnect(t(0));
    lifecycle.onConnect(t(100));
    lifecycle.onDisconnect(t(200));

    const state = lifecycle.stateAt(t(60_000));
    expect(state.status).toBe('reviewing');
    expect(state.clients).toBe(1);
    expect(state.idleSince).toBeNull();
    expect(state.disconnects).toBe(0);
  });

  it('counts each drop to zero, even ones inside the grace period', () => {
    const lifecycle = new ReviewLifecycle(10_000);
    lifecycle.onConnect(t(0));
    lifecycle.onDisconnect(t(1_000));
    lifecycle.onConnect(t(2_000));
    lifecycle.onDisconnect(t(3_000));

    expect(lifecycle.stateAt(t(3_500)).disconnects).toBe(2);
  });

  it('never drops the client count below zero on a duplicate disconnect', () => {
    const lifecycle = new ReviewLifecycle(10_000);
    lifecycle.onConnect(t(0));
    lifecycle.onDisconnect(t(1_000));
    lifecycle.onDisconnect(t(1_100));

    const state = lifecycle.stateAt(t(1_200));
    expect(state.clients).toBe(0);
    expect(state.disconnects).toBe(1);
  });

  it('treats a zero grace period as immediately idle', () => {
    const lifecycle = new ReviewLifecycle(0);
    lifecycle.onConnect(t(0));
    lifecycle.onDisconnect(t(1_000));

    expect(lifecycle.stateAt(t(1_000)).terminal).toBe(true);
  });
});
