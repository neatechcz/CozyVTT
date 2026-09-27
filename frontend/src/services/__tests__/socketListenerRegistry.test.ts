/**
 * Socket listener registry
 *
 * The bug this pins was invisible from the UI: `connect()` builds a brand new
 * socket.io instance and discards the old one, but components subscribe from
 * effects keyed on the socket *client* — a singleton whose identity never
 * changes — so those effects never re-run and nothing re-subscribed to the
 * replacement. Every listener in the app silently stopped firing after a
 * reconnect.
 *
 * The visible symptom was the dice panel wedging on "Rolling…" forever, because
 * `setIsRolling(false)` only happens inside the `dice.rolled` and `error`
 * handlers. Users could not identify a trigger because the trigger was a
 * websocket reconnect, which has no UI.
 *
 * These tests drive the client against a fake socket.io so a "reconnect" can be
 * forced deterministically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Minimal stand-in for a socket.io Socket, recording what is attached to it. */
class FakeSocket {
  handlers = new Map<string, Set<(data: unknown) => void>>();
  connected = false;
  disconnected = false;

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
    this.disconnected = true;
    this.connected = false;
  }
  emit() {
    /* outbound, irrelevant here */
  }

  /** Pretend the server sent an event. */
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

/** The newest socket the client built. */
const current = () => sockets[sockets.length - 1];

/**
 * Complete a full connection, including the handshake.
 *
 * connect() only settles once the backend emits `connected` and then
 * `authenticated`, and it refuses to start a second attempt while one is in
 * flight — so the handshake has to be played out or a later "reconnect" would
 * be rejected rather than building a new socket.
 */
async function connect(client: { connect: (id: string) => Promise<void> }, campaignId = 'campaign-1') {
  const pending = client.connect(campaignId);
  await Promise.resolve();       // let io() run and the lifecycle handlers attach
  current().fire('connected');   // backend ready -> client emits 'authenticate'
  current().fire('authenticated');
  await pending;
}

describe('socket listener registry', () => {
  let client: typeof import('../socket').default;

  beforeEach(async () => {
    sockets.length = 0;
    vi.resetModules();
    client = (await import('../socket')).default;
  });

  it('delivers events on the first connection', async () => {
    await connect(client);
    const received: unknown[] = [];
    client.on('dice.rolled', (d) => received.push(d));

    current().fire('dice.rolled', { result: 7 });
    expect(received).toEqual([{ result: 7 }]);
  });

  // The regression itself.
  it('keeps delivering events after the socket is replaced', async () => {
    await connect(client);
    const received: unknown[] = [];
    client.on('dice.rolled', (d) => received.push(d));

    // A reconnect: connect() discards the old socket and builds a new one.
    await connect(client, 'campaign-1');
    expect(sockets.length).toBe(2);
    expect(current()).not.toBe(sockets[0]);

    current().fire('dice.rolled', { result: 20 });
    expect(received).toEqual([{ result: 20 }]);
  });

  it('re-attaches listeners registered through the typed helpers too', async () => {
    await connect(client);
    const rolls: unknown[] = [];
    // onDiceRolled is representative of the ~22 typed wrappers.
    client.onDiceRolled((d) => rolls.push(d));

    await connect(client, 'campaign-1');
    current().fire('dice.rolled', { result: 12 });

    expect(rolls).toEqual([{ result: 12 }]);
  });

  it('survives several reconnects without duplicating handlers', async () => {
    await connect(client);
    const received: unknown[] = [];
    client.on('chat.message', (d) => received.push(d));

    await connect(client, 'campaign-1');
    await connect(client, 'campaign-1');
    await connect(client, 'campaign-1');

    // Exactly one handler on the live socket — a registry that appended without
    // rebuilding would fan out and deliver the same message repeatedly.
    expect(current().countFor('chat.message')).toBe(1);

    current().fire('chat.message', { text: 'hello' });
    expect(received).toEqual([{ text: 'hello' }]);
  });

  it('stops delivering once a listener is removed', async () => {
    await connect(client);
    const received: unknown[] = [];
    const handler = (d: unknown) => received.push(d);
    client.on('dice.rolled', handler);
    client.off('dice.rolled', handler);

    // Removal must clear the registry, not just the live socket — otherwise the
    // listener would come back to life on the next reconnect.
    await connect(client, 'campaign-1');
    current().fire('dice.rolled', { result: 3 });

    expect(received).toEqual([]);
    expect(current().countFor('dice.rolled')).toBe(0);
  });

  it('removeAllListeners clears the registry as well as the socket', async () => {
    await connect(client);
    const received: unknown[] = [];
    client.on('dice.rolled', (d) => received.push(d));

    client.removeAllListeners();
    await connect(client, 'campaign-1');
    current().fire('dice.rolled', { result: 5 });

    expect(received).toEqual([]);
  });
});
