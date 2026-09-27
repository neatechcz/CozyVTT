/**
 * useInitiativeSync listener lifecycle
 *
 * The hook subscribes through the socket *client*, which keeps a registry so
 * listeners survive a reconnect. Cleanup therefore has to go through the client
 * too. It originally unsubscribed with `socket.getSocket()?.off(...)`, which
 * detaches from the live socket.io instance but leaves the callback in the
 * registry — so the next reconnect re-attached a handler belonging to a hook
 * that had already been torn down, one more copy per reconnect.
 *
 * Nothing about that is visible from the UI until initiative state starts being
 * applied by a component that no longer exists, so it is pinned here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

/** Minimal stand-in for a socket.io Socket. */
class FakeSocket {
  handlers = new Map<string, Set<(data: unknown) => void>>();
  connected = false;

  on(event: string, cb: (data: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(cb);
  }
  off(event: string, cb?: (data: unknown) => void) {
    if (cb) this.handlers.get(event)?.delete(cb);
    else this.handlers.delete(event);
  }
  removeAllListeners() {
    this.handlers.clear();
  }
  disconnect() {
    this.connected = false;
  }
  emit() {
    /* outbound, irrelevant here */
  }
  fire(event: string, data?: unknown) {
    for (const cb of this.handlers.get(event) ?? []) cb(data);
  }
  countFor(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }
}

const sockets: FakeSocket[] = [];

vi.mock('socket.io-client', () => ({
  io: () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  },
}));

const applied: unknown[] = [];
vi.mock('@/stores/gameStore', () => ({
  useGameStore: {
    getState: () => ({ setCombatState: (s: unknown) => applied.push(s) }),
  },
}));

// The hook reads the client off the context; the provider itself is not under
// test, so stand in for it with the real singleton client.
let clientForContext: any;
vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocket: () => ({
    socket: clientForContext,
    status: 'connected',
    reconnectCount: 0,
  }),
}));

const current = () => sockets[sockets.length - 1];

/** Complete a full connection, handshake included. */
async function connect(client: { connect: (id: string) => Promise<void> }, campaignId = 'campaign-1') {
  const pending = client.connect(campaignId);
  await Promise.resolve();
  current().fire('connected');
  current().fire('authenticated');
  await pending;
}

describe('useInitiativeSync listener lifecycle', () => {
  let client: any;
  let useInitiativeSync: typeof import('../useInitiativeSync').useInitiativeSync;

  beforeEach(async () => {
    sockets.length = 0;
    applied.length = 0;
    vi.resetModules();
    client = (await import('@/services/socket')).default;
    clientForContext = client;
    useInitiativeSync = (await import('../useInitiativeSync')).useInitiativeSync;
  });

  it('applies initiative state while mounted', async () => {
    await connect(client);
    renderHook(() => useInitiativeSync());

    current().fire('initiative.state', { round: 1 });
    expect(applied).toEqual([{ round: 1 }]);
  });

  // The regression: cleanup must clear the registry, not just the live socket.
  it('stops applying state after unmount, even across a reconnect', async () => {
    await connect(client);
    const { unmount } = renderHook(() => useInitiativeSync());
    unmount();

    // A reconnect re-attaches everything still in the registry. A handler that
    // was only detached from the old socket instance would come back here.
    await connect(client, 'campaign-1');
    current().fire('initiative.state', { round: 2 });

    expect(applied).toEqual([]);
    expect(current().countFor('initiative.state')).toBe(0);
  });

  it('does not accumulate handlers across repeated mounts', async () => {
    await connect(client);

    for (let i = 0; i < 3; i++) {
      const { unmount } = renderHook(() => useInitiativeSync());
      unmount();
    }
    renderHook(() => useInitiativeSync());

    // Exactly one live handler; leaked registry entries would fan out and apply
    // the same combat state several times over.
    expect(current().countFor('initiative.state')).toBe(1);

    current().fire('initiative.state', { round: 3 });
    expect(applied).toEqual([{ round: 3 }]);
  });
});
