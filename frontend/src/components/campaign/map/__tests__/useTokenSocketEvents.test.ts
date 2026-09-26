import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createdSockets as created, handshake } from '@/test/fakeSocketIo';
import { socketClient } from '@/services/socket';
import { useGameStore } from '@/stores/gameStore';
import type { Token } from '@/types';
import { useTokenSocketEvents } from '../useTokenSocketEvents';

// MapCanvas's token listeners subscribe once to the stable socket client
// ([socket, currentMapId] deps). When the client builds a new underlying
// socket (server-forced reconnect, browser back online) they must keep
// receiving token.added / token.updated / token.removed / token.moved.

vi.mock('socket.io-client', async () => (await import('@/test/fakeSocketIo')).fakeSocketIoModule);

const token = (id: string, x: number, y: number): Token =>
  ({ id, name: id, position: { x, y }, visible: true } as unknown as Token);

beforeEach(() => {
  created.length = 0;
  vi.useFakeTimers();
  useGameStore.getState().setTokens([token('t1', 0, 0)]);
});

afterEach(() => {
  socketClient.disconnect();
  vi.useRealTimers();
});

describe('MapCanvas token socket listeners', () => {
  it('keep receiving token events after the socket client replaces its socket', async () => {
    const connecting = socketClient.connect('camp-1');
    handshake(created[0]);
    await connecting;

    const startAnimation = vi.fn();
    renderHook(() => useTokenSocketEvents(socketClient, 'map-1', startAnimation));

    act(() => created[0].fire('token.added', { mapId: 'map-1', token: token('t2', 1, 1) }));
    expect(useGameStore.getState().tokenOrder).toEqual(['t1', 't2']);

    // Server-forced disconnect: the client builds a new socket after a backoff
    created[0].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(3000);
    expect(created).toHaveLength(2);
    handshake(created[1]);

    act(() => created[1].fire('token.added', { mapId: 'map-1', token: token('t3', 2, 2) }));
    act(() => created[1].fire('token.updated', { mapId: 'map-1', token: token('t2', 5, 5) }));
    act(() => created[1].fire('token.removed', { mapId: 'map-1', tokenId: 't3' }));
    act(() => created[1].fire('token.moved', { tokenId: 't1', x: 4, y: 3 }));

    const { tokens, tokenOrder } = useGameStore.getState();
    expect(tokenOrder).toEqual(['t1', 't2']);
    expect(tokens.t2.position).toEqual({ x: 5, y: 5 });
    expect(tokens.t1.position).toEqual({ x: 4, y: 3 });
    expect(startAnimation).toHaveBeenCalledTimes(1);
    expect(startAnimation).toHaveBeenCalledWith('t1', expect.objectContaining({ fromX: 0, fromY: 0, toX: 4, toY: 3 }));
  });

  it('events for another map are ignored and unmount unsubscribes', async () => {
    const connecting = socketClient.connect('camp-1');
    handshake(created[0]);
    await connecting;
    const hook = renderHook(() => useTokenSocketEvents(socketClient, 'map-1', vi.fn()));

    act(() => created[0].fire('token.added', { mapId: 'map-2', token: token('t9', 1, 1) }));
    expect(useGameStore.getState().tokenOrder).toEqual(['t1']);

    hook.unmount();
    expect(created[0].listenerCount('token.added')).toBe(0);
    expect(created[0].listenerCount('token.moved')).toBe(0);
  });
});
