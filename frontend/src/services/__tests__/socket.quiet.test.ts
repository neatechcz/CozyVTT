import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Listener = (...args: any[]) => void;

class FakeManager {
  listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  // The client detaches its reconnect_* handlers from a replaced socket's Manager
  off(event: string, listener?: Listener) {
    this.listeners.set(event, listener ? (this.listeners.get(event) ?? []).filter((l) => l !== listener) : []);
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

class FakeSocket {
  connected = false;
  /** socket.io Manager: reconnect_* events are emitted here, not on the socket */
  io = new FakeManager();
  listeners = new Map<string, Listener[]>();
  emitted: { event: string; payload: unknown }[] = [];
  disconnect = vi.fn(() => {
    this.connected = false;
  });

  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  off(event: string, listener?: Listener) {
    this.listeners.set(event, listener ? (this.listeners.get(event) ?? []).filter((l) => l !== listener) : []);
    return this;
  }
  removeAllListeners() {
    this.listeners.clear();
    return this;
  }
  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
    return this;
  }
  /** Server → client event */
  fire(event: string, ...args: unknown[]) {
    if (event === 'connect' || event === 'connected') this.connected = true;
    if (event === 'disconnect') this.connected = false;
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  authenticatePayloads() {
    return this.emitted.filter((e) => e.event === 'authenticate').map((e) => e.payload);
  }
}

const created: FakeSocket[] = [];

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const socket = new FakeSocket();
    created.push(socket);
    return socket;
  }),
}));

async function freshClient() {
  vi.resetModules();
  const mod = await import('../socket');
  return mod.socketClient;
}

/** Drives a fake socket through the backend handshake up to `authenticated`. */
function handshake(socket: FakeSocket) {
  socket.fire('connect');
  socket.fire('connected', { userId: 'u1' });
  socket.fire('authenticated', { campaignId: 'camp-1' });
}

beforeEach(() => {
  created.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('socketClient quiet campaign join', () => {
  it('sends quiet: true with authenticate and reports the connected campaign', async () => {
    const client = await freshClient();

    const connecting = client.connect('camp-1', { quiet: true });
    handshake(created[0]);
    await connecting;

    expect(created[0].authenticatePayloads()).toEqual([{ campaignId: 'camp-1', quiet: true }]);
    expect(client.getCampaignId()).toBe('camp-1');
    expect(client.isConnected()).toBe(true);
  });

  it('keeps the normal authenticate payload for a normal join', async () => {
    const client = await freshClient();

    const connecting = client.connect('camp-1');
    handshake(created[0]);
    await connecting;

    expect(created[0].authenticatePayloads()).toEqual([{ campaignId: 'camp-1' }]);
  });

  it('re-sends quiet on socket.io auto-reconnect', async () => {
    const client = await freshClient();
    const connecting = client.connect('camp-1', { quiet: true });
    handshake(created[0]);
    await connecting;

    // Transport dropped and socket.io reconnected the same socket
    created[0].fire('disconnect', 'transport close');
    created[0].fire('connect');
    created[0].fire('connected', { userId: 'u1' });

    expect(created[0].authenticatePayloads()).toEqual([
      { campaignId: 'camp-1', quiet: true },
      { campaignId: 'camp-1', quiet: true },
    ]);
  });

  it('re-sends quiet on the manual reconnect after a server disconnect', async () => {
    vi.useFakeTimers();
    const client = await freshClient();
    const connecting = client.connect('camp-1', { quiet: true });
    handshake(created[0]);
    await connecting;

    created[0].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(3000);

    expect(created).toHaveLength(2);
    created[1].fire('connect');
    created[1].fire('connected', { userId: 'u1' });
    expect(created[1].authenticatePayloads()).toEqual([{ campaignId: 'camp-1', quiet: true }]);
  });

  it('a later normal connect to another campaign is not quiet', async () => {
    const client = await freshClient();
    const first = client.connect('camp-1', { quiet: true });
    handshake(created[0]);
    await first;

    const second = client.connect('camp-2');
    created[1].fire('connected', { userId: 'u1' });
    created[1].fire('authenticated', { campaignId: 'camp-2' });
    await second;

    expect(created[1].authenticatePayloads()).toEqual([{ campaignId: 'camp-2' }]);
    expect(client.getCampaignId()).toBe('camp-2');
  });

  it('the timeout of an abandoned connection does not tear down a newer one', async () => {
    vi.useFakeTimers();
    const client = await freshClient();

    // Page opens a connection, then unmounts before it is authenticated
    const abandoned = client.connect('camp-1', { quiet: true });
    abandoned.catch(() => undefined);
    client.disconnect();

    // Next page connects and authenticates
    const next = client.connect('camp-1');
    handshake(created[1]);
    await next;

    await vi.advanceTimersByTimeAsync(10_000);

    expect(created[1].disconnect).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(true);
    expect(client.getSocket()).toBe(created[1]);
  });
});

describe('socketClient lifecycle signals', () => {
  it('signals replaced for every new underlying socket, authenticated for every join, disconnected for drops', async () => {
    vi.useFakeTimers();
    const client = await freshClient();
    const events: string[] = [];
    const unsubscribe = client.onLifecycle((event) => events.push(event));

    const connecting = client.connect('camp-1', { quiet: true });
    expect(events).toEqual(['replaced']);
    handshake(created[0]);
    await connecting;
    expect(events).toEqual(['replaced', 'authenticated']);

    // socket.io auto-reconnect of the same socket
    created[0].fire('disconnect', 'transport close');
    created[0].fire('connect');
    created[0].fire('connected', { userId: 'u1' });
    created[0].fire('authenticated', { campaignId: 'camp-1' });
    expect(events).toEqual(['replaced', 'authenticated', 'disconnected', 'authenticated']);

    // Server-forced disconnect: the client recreates the underlying socket
    created[0].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(3000);
    expect(created).toHaveLength(2);
    expect(events.slice(-2)).toEqual(['disconnected', 'replaced']);

    unsubscribe();
    handshake(created[1]);
    expect(events.slice(-1)).toEqual(['replaced']);
  });

  it('signals failed when socket.io gives up reconnecting', async () => {
    const client = await freshClient();
    const events: string[] = [];
    client.onLifecycle((event) => events.push(event));
    const connecting = client.connect('camp-1', { quiet: true });
    handshake(created[0]);
    await connecting;

    created[0].io.fire('reconnect_failed');

    expect(events.slice(-1)).toEqual(['failed']);
  });

  it('keeps one reconnect_* handler per Manager and detaches it from a replaced socket', async () => {
    vi.useFakeTimers();
    const client = await freshClient();
    const events: string[] = [];
    client.onLifecycle((event) => events.push(event));
    const connecting = client.connect('camp-1');
    handshake(created[0]);
    await connecting;
    expect(created[0].io.listeners.get('reconnect_failed')).toHaveLength(1);

    created[0].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(3000);
    expect(created).toHaveLength(2);
    expect(created[0].io.listeners.get('reconnect_failed')).toHaveLength(0);
    expect(created[1].io.listeners.get('reconnect_failed')).toHaveLength(1);

    // The old Manager giving up no longer reports the current connection as failed
    created[0].io.fire('reconnect_failed');
    expect(events).not.toContain('failed');
    created[1].io.fire('reconnect_failed');
    expect(events.filter((event) => event === 'failed')).toHaveLength(1);
  });
});
