import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createdSockets as created, handshake, type FakeSocket } from '@/test/fakeSocketIo';
import type { SocketLifecycleDetail, SocketLifecycleEvent } from '../socket';

// Reconnect lifecycle of the socket client: socket.io v4 reports its own
// retries on the Manager (`socket.io`); the client retries a server-forced
// disconnect ('io server disconnect') itself — bounded, with backoff — and
// reports every way of giving up as the 'failed' lifecycle signal.

vi.mock('socket.io-client', async () => (await import('@/test/fakeSocketIo')).fakeSocketIoModule);

async function freshClient() {
  vi.resetModules();
  const mod = await import('../socket');
  return mod.socketClient;
}

type Signal = { event: SocketLifecycleEvent; detail?: SocketLifecycleDetail };

async function connectedWithSignals() {
  const client = await freshClient();
  const signals: Signal[] = [];
  client.onLifecycle((event, detail) => signals.push(detail ? { event, detail } : { event }));
  const connecting = client.connect('camp-1');
  handshake(created[0]);
  await connecting;
  return { client, signals };
}

/** The backend rejects a connection whose session is not valid (events.ts) */
function rejectUnauthenticated(socket: FakeSocket) {
  socket.fire('connect');
  socket.fire('error', { message: 'Unauthorized' });
  socket.fire('disconnect', 'io server disconnect');
}

const RECONNECT_EVENTS = ['reconnect_attempt', 'reconnect', 'reconnect_error', 'reconnect_failed'];

beforeEach(() => {
  created.length = 0;
  vi.useFakeTimers();
  // No jitter: the retry delays are exactly 1 s, 2 s, 4 s, 8 s, 16 s
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('socketClient reconnect listeners live on the Manager', () => {
  it('listens for reconnect_* on the Manager of every new socket, never on the socket, and detaches on replacement', async () => {
    const { client } = await connectedWithSignals();
    for (const event of RECONNECT_EVENTS) expect(created[0].listenerCount(event)).toBe(0);
    expect(created[0].io.listenerCount('reconnect_failed')).toBe(1);

    created[0].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(1000);
    expect(created).toHaveLength(2);
    for (const event of RECONNECT_EVENTS) {
      expect(created[0].io.listenerCount(event)).toBe(0);
      expect(created[1].listenerCount(event)).toBe(0);
    }
    expect(created[1].io.listenerCount('reconnect_failed')).toBe(1);

    client.disconnect();
    for (const event of RECONNECT_EVENTS) expect(created[1].io.listenerCount(event)).toBe(0);
  });
});

describe('socketClient reconnect after a server-forced disconnect', () => {
  it('signals failed when the replacement connection times out (nothing retries it)', async () => {
    const { client, signals } = await connectedWithSignals();

    created[0].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(1000);
    expect(created).toHaveLength(2);
    // Transport comes up, but the campaign join is never confirmed
    created[1].fire('connect');
    expect(signals.map((s) => s.event)).not.toContain('failed');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(signals.slice(-1)).toEqual([
      { event: 'failed', detail: { error: 'Connection timeout - server did not respond' } },
    ]);
    expect(client.getSocket()).toBeNull();
    // Given up: no further socket is built
    await vi.advanceTimersByTimeAsync(120_000);
    expect(created).toHaveLength(2);
  });

  it('stops retrying an unauthenticated connection after a bounded number of attempts with backoff and surfaces the error', async () => {
    const { signals } = await connectedWithSignals();

    // The session expired: the server kicks the connection ...
    created[0].fire('disconnect', 'io server disconnect');
    // ... and rejects every new one before it can join the campaign
    const delays = [1000, 2000, 4000, 8000, 16000];
    for (const [attempt, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(created).toHaveLength(attempt + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(created).toHaveLength(attempt + 2);
      rejectUnauthenticated(created[attempt + 1]);
    }

    expect(signals.slice(-1)).toEqual([{ event: 'failed', detail: { error: 'Unauthorized' } }]);
    expect(signals.filter((s) => s.event === 'failed')).toHaveLength(1);

    // No endless loop
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(created).toHaveLength(1 + delays.length);
  });

  it('a successful campaign join starts a new series of attempts', async () => {
    const { signals } = await connectedWithSignals();

    // Three kicks in a row, then the fourth socket joins the campaign again
    created[0].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(1000);
    rejectUnauthenticated(created[1]);
    await vi.advanceTimersByTimeAsync(2000);
    rejectUnauthenticated(created[2]);
    await vi.advanceTimersByTimeAsync(4000);
    handshake(created[3]);
    expect(created).toHaveLength(4);

    // A later server-forced disconnect is retried from the first delay again,
    // with all five attempts available
    created[3].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(1000);
    expect(created).toHaveLength(5);
    for (const [i, delay] of [2000, 4000, 8000, 16000].entries()) {
      rejectUnauthenticated(created[4 + i]);
      await vi.advanceTimersByTimeAsync(delay);
      expect(created).toHaveLength(6 + i);
    }
    expect(signals.map((s) => s.event)).not.toContain('failed');
  });

  it('a manual connect() starts a new series of attempts after the client gave up', async () => {
    const { client, signals } = await connectedWithSignals();
    created[0].fire('disconnect', 'io server disconnect');
    for (const [i, delay] of [1000, 2000, 4000, 8000, 16000].entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      rejectUnauthenticated(created[i + 1]);
    }
    expect(signals.filter((s) => s.event === 'failed')).toHaveLength(1);
    expect(created).toHaveLength(6);

    // Retry button / user signed in again
    client.disconnect();
    const connecting = client.connect('camp-1');
    connecting.catch(() => undefined);
    rejectUnauthenticated(created[6]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(created).toHaveLength(8);
  });

  it('a caller connect() without disconnect() (standalone editor retry) starts a new series', async () => {
    const { client, signals } = await connectedWithSignals();
    created[0].fire('disconnect', 'io server disconnect');
    for (const [i, delay] of [1000, 2000, 4000, 8000, 16000].entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      rejectUnauthenticated(created[i + 1]);
    }
    expect(signals.filter((s) => s.event === 'failed')).toHaveLength(1);
    expect(created).toHaveLength(6);

    // The editor page retries on its own: connect() straight away
    const connecting = client.connect('camp-1');
    connecting.catch(() => undefined);
    expect(created).toHaveLength(7);
    expect(created[5].disconnect).toHaveBeenCalled();
    rejectUnauthenticated(created[6]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(created).toHaveLength(8);
  });

  it('does not report an unrelated earlier server error when a retry series gives up', async () => {
    const { signals } = await connectedWithSignals();
    // A domain error while connected (e.g. a rejected token move)
    created[0].fire('error', { message: 'You cannot move this token' });

    // Later the server kicks the connection and every retry, without saying why
    created[0].fire('disconnect', 'io server disconnect');
    for (const [i, delay] of [1000, 2000, 4000, 8000, 16000].entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      created[i + 1].fire('connect');
      created[i + 1].fire('disconnect', 'io server disconnect');
    }

    expect(signals.slice(-1)).toEqual([{ event: 'failed' }]);
  });

  it('a pending retry does not replace a connection opened after disconnect()', async () => {
    const { client } = await connectedWithSignals();
    created[0].fire('disconnect', 'io server disconnect');

    // Before the retry is due the page reconnects by itself (Retry / back online)
    client.disconnect();
    const connecting = client.connect('camp-1');
    handshake(created[1]);
    await connecting;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(created).toHaveLength(2);
    expect(client.getSocket()).toBe(created[1]);
    expect(created[1].disconnect).not.toHaveBeenCalled();
  });

  it('signals failed without a detail when socket.io exhausts its own retries', async () => {
    const { signals } = await connectedWithSignals();
    created[0].fire('disconnect', 'transport close');
    created[0].io.fire('reconnect_failed');
    expect(signals.slice(-1)).toEqual([{ event: 'failed' }]);
  });
});
