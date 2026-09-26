import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createdSockets as created, handshake } from '@/test/fakeSocketIo';

// Listeners added through socketClient.on() / the onX() helpers must survive
// the client building a new underlying socket (server-forced reconnect,
// browser back online): consumers subscribe once to the stable client.

vi.mock('socket.io-client', async () => (await import('@/test/fakeSocketIo')).fakeSocketIoModule);

async function freshClient() {
  vi.resetModules();
  const mod = await import('../socket');
  return mod.socketClient;
}

async function connected() {
  const client = await freshClient();
  const connecting = client.connect('camp-1');
  handshake(created[0]);
  await connecting;
  return client;
}

/** Server-forced disconnect: the client builds a new socket after a backoff */
async function forceReplacement() {
  const before = created.length;
  created[before - 1].fire('disconnect', 'io server disconnect');
  await vi.advanceTimersByTimeAsync(3000);
  expect(created).toHaveLength(before + 1);
  handshake(created[before]);
  return created[before];
}

beforeEach(() => {
  created.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('socketClient listener registry', () => {
  it('re-attaches every registered listener to a new underlying socket', async () => {
    const client = await connected();
    const onUpdated = vi.fn();
    const onTokenAdded = vi.fn();
    client.on('character.updated', onUpdated);
    client.onTokenAdded(onTokenAdded);

    const replacement = await forceReplacement();
    replacement.fire('character.updated', { characterId: 'c1' });
    replacement.fire('token.added', { mapId: 'm1' });

    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith({ characterId: 'c1' });
    expect(onTokenAdded).toHaveBeenCalledTimes(1);
    // The old socket was cleaned up, the new one holds each listener once
    expect(created[0].listenerCount('character.updated')).toBe(0);
    expect(replacement.listenerCount('character.updated')).toBe(1);
  });

  it('a listener added before the first connect is attached when the socket is created', async () => {
    const client = await freshClient();
    const onUpdated = vi.fn();
    client.on('character.updated', onUpdated);

    const connecting = client.connect('camp-1');
    handshake(created[0]);
    await connecting;
    created[0].fire('character.updated', { characterId: 'c1' });

    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('off() removes the listener from the current socket and from later ones', async () => {
    const client = await connected();
    const onUpdated = vi.fn();
    const onTokenRemoved = vi.fn();
    client.on('character.updated', onUpdated);
    client.onTokenRemoved(onTokenRemoved);

    client.off('character.updated', onUpdated);
    client.offTokenRemoved(onTokenRemoved);
    created[0].fire('character.updated', {});
    created[0].fire('token.removed', {});

    const replacement = await forceReplacement();
    replacement.fire('character.updated', {});
    replacement.fire('token.removed', {});

    expect(onUpdated).not.toHaveBeenCalled();
    expect(onTokenRemoved).not.toHaveBeenCalled();
    expect(replacement.listenerCount('character.updated')).toBe(0);
  });

  it('adding the same handler twice subscribes it once (no double delivery after replacement)', async () => {
    const client = await connected();
    const onUpdated = vi.fn();
    client.on('character.updated', onUpdated);
    client.on('character.updated', onUpdated);

    created[0].fire('character.updated', {});
    expect(onUpdated).toHaveBeenCalledTimes(1);

    const replacement = await forceReplacement();
    replacement.fire('character.updated', {});
    expect(onUpdated).toHaveBeenCalledTimes(2);
  });

  it('a subscriber that resubscribes on "replaced" (standalone editor) ends up subscribed once', async () => {
    const client = await connected();
    let current = vi.fn();
    client.on('character.updated', current);
    const first = current;
    client.onLifecycle((event) => {
      if (event !== 'replaced') return;
      // What the hook effect does when the page bumps the socket generation
      client.off('character.updated', current);
      current = vi.fn();
      client.on('character.updated', current);
    });

    const replacement = await forceReplacement();
    replacement.fire('character.updated', {});

    expect(first).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
    expect(replacement.listenerCount('character.updated')).toBe(1);
  });

  it('keeps listeners across a manual disconnect() and a new connect() (browser back online)', async () => {
    const client = await connected();
    const onMoved = vi.fn();
    client.onTokenMoved(onMoved);

    client.disconnect();
    const connecting = client.connect('camp-1');
    handshake(created[1]);
    await connecting;
    created[1].fire('token.moved', { tokenId: 't1', x: 1, y: 2 });

    expect(onMoved).toHaveBeenCalledTimes(1);
  });
});
