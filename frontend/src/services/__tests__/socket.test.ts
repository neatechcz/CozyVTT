import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socketIoMock = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => socketIoMock);

import socketClient from '../socket';

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }

  removeAllListeners() {
    this.listeners.clear();
  }

  listenerCount(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeSocket extends FakeEmitter {
  connected = false;
  io = new FakeEmitter();
  disconnect = vi.fn();
}

describe('SocketClient manager reconnect listeners', () => {
  let socket: FakeSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    socket = new FakeSocket();
    socketIoMock.io.mockReturnValue(socket);
  });

  afterEach(() => {
    socketClient.disconnect();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('handles reconnect exhaustion from the Manager and removes its listeners on disconnect', async () => {
    const connection = socketClient.connect('c1');
    const manager = socket.io;

    expect(socket.listenerCount('reconnect_attempt')).toBe(0);
    expect(socket.listenerCount('reconnect')).toBe(0);
    expect(socket.listenerCount('reconnect_failed')).toBe(0);
    expect(manager.listenerCount('reconnect_attempt')).toBe(1);
    expect(manager.listenerCount('reconnect')).toBe(1);
    expect(manager.listenerCount('reconnect_failed')).toBe(1);

    const connectionError = expect(connection).rejects.toThrow(
      'Failed to reconnect after maximum attempts'
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    manager.emit('reconnect_failed');
    await vi.advanceTimersByTimeAsync(10_000);

    await connectionError;

    socketClient.disconnect();
    expect(manager.listenerCount('reconnect_attempt')).toBe(0);
    expect(manager.listenerCount('reconnect')).toBe(0);
    expect(manager.listenerCount('reconnect_failed')).toBe(0);
  });
});
