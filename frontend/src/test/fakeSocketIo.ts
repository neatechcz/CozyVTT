// ============================================
// Fake socket.io-client for tests that drive the real `socketClient`.
//
//   vi.mock('socket.io-client', async () => (await import('@/test/fakeSocketIo')).fakeSocketIoModule);
//
// Every `io()` call creates a FakeSocket and records it in `createdSockets`
// (reset it in beforeEach); `fire()` delivers a server → client event.
// ============================================

import { vi } from 'vitest';

type Listener = (...args: any[]) => void;

let fakeSocketIdCounter = 0;

class FakeManager {
  listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  off(event: string, listener?: Listener) {
    this.listeners.set(event, listener ? (this.listeners.get(event) ?? []).filter((l) => l !== listener) : []);
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
  listenerCount(event: string) {
    return this.listeners.get(event)?.length ?? 0;
  }
}

export class FakeSocket {
  connected = false;
  /** Unique per instance, like socket.io's real `Socket#id` — lets tests tell
   * "this client's own socket" apart from another client's. */
  id = `fake-socket-${++fakeSocketIdCounter}`;
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
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
  listenerCount(event: string) {
    return this.listeners.get(event)?.length ?? 0;
  }
}

/**
 * Shared through globalThis: `vi.resetModules()` (fresh socketClient per
 * test) re-evaluates this module for the mock, but the test's own import
 * must see the same list.
 */
const shared = globalThis as typeof globalThis & { __fakeSocketIoCreated?: FakeSocket[] };
export const createdSockets: FakeSocket[] = (shared.__fakeSocketIoCreated ??= []);

export const fakeSocketIoModule = {
  io: vi.fn(() => {
    const socket = new FakeSocket();
    createdSockets.push(socket);
    return socket;
  }),
};

/** Drives a fake socket through the backend handshake up to `authenticated`. */
export function handshake(socket: FakeSocket, campaignId = 'camp-1') {
  socket.fire('connect');
  socket.fire('connected', { userId: 'u1' });
  socket.fire('authenticated', { campaignId });
}
