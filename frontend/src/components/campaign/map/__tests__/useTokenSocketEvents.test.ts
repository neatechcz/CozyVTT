import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createdSockets as created, handshake } from '@/test/fakeSocketIo';
import { socketClient } from '@/services/socket';
import { useGameStore } from '@/stores/gameStore';
import type { Token, TokenMoveAcceptedEvent, TokenMoveRejectedEvent } from '@/types';
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

  it('keeps drag previews out of canonical positions and filters them by map', async () => {
    const connecting = socketClient.connect('camp-1');
    handshake(created[0]);
    await connecting;
    const hook = renderHook(() => useTokenSocketEvents(socketClient, 'map-1', vi.fn()));

    act(() => created[0].fire('token.move.preview', {
      tokenId: 't1', mapId: 'map-2', x: 6, y: 7,
      position: { x: 6, y: 7 }, movedBy: 'other', preview: true,
    }));
    expect(useGameStore.getState().tokens.t1.position).toEqual({ x: 0, y: 0 });
    expect(hook.result.current?.movementPreviews).toEqual({});

    act(() => created[0].fire('token.move.preview', {
      tokenId: 't1', mapId: 'map-1', x: 2, y: 3,
      position: { x: 2, y: 3 }, movedBy: 'other', preview: true,
    }));
    expect(useGameStore.getState().tokens.t1.position).toEqual({ x: 0, y: 0 });
    expect(hook.result.current?.movementPreviews.t1.position).toEqual({ x: 2, y: 3 });

    act(() => created[0].fire('token.move.preview', {
      tokenId: 't1', mapId: 'map-1', x: 0, y: 0,
      position: { x: 0, y: 0 }, movedBy: 'other', preview: false,
    }));
    expect(hook.result.current?.movementPreviews).toEqual({});
    expect(useGameStore.getState().tokens.t1.position).toEqual({ x: 0, y: 0 });
  });

  it('ignores committed moves for a map other than the displayed map', async () => {
    const connecting = socketClient.connect('camp-1');
    handshake(created[0]);
    await connecting;
    renderHook(() => useTokenSocketEvents(socketClient, 'map-1', vi.fn()));

    act(() => created[0].fire('token.moved', { tokenId: 't1', mapId: 'map-2', x: 8, y: 9 }));
    expect(useGameStore.getState().tokens.t1.position).toEqual({ x: 0, y: 0 });
  });

  it('forwards accepted and rejected move responses to the pending drag owner', async () => {
    const connecting = socketClient.connect('camp-1');
    handshake(created[0]);
    await connecting;
    const onMoveResponse = vi.fn();
    renderHook(() => useTokenSocketEvents(socketClient, 'map-1', vi.fn(), onMoveResponse));
    const rejected = {
      requestId: 'request-1', tokenId: 't1', mapId: 'map-1',
      position: { x: 0, y: 0 },
      movement: { speedFeet: 30, spentFeet: 0, dashBonusFeet: 0, remainingMovementFeet: 30 },
      error: { code: 'INSUFFICIENT_MOVEMENT', message: 'Only 5 ft of movement remain.' },
    };
    const accepted = {
      requestId: 'request-0', tokenId: 't1', mapId: 'map-1',
      position: { x: 2, y: 1 },
      movement: {
        turnId: 'turn-1', speedFeet: 30, movementCostFeet: 5, spentFeet: 5,
        dashBonusFeet: 0, remainingMovementFeet: 25, dashUsed: false,
        diagonalStepsTaken: 0, route: [{ x: 2, y: 1 }], override: false,
      },
    };

    act(() => created[0].fire('token.move.accepted', accepted));
    act(() => created[0].fire('token.move.rejected', rejected));

    expect(onMoveResponse).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accepted: true,
      ...accepted,
    }));
    expect(onMoveResponse).toHaveBeenCalledWith(expect.objectContaining({
      accepted: false,
      ...rejected,
    }));
  });

  it('forwards nullable movement data from out-of-combat and early rejection responses', async () => {
    const connecting = socketClient.connect('camp-1');
    handshake(created[0]);
    await connecting;
    const onMoveResponse = vi.fn();
    renderHook(() => useTokenSocketEvents(socketClient, 'map-1', vi.fn(), onMoveResponse));

    const accepted: TokenMoveAcceptedEvent = {
      requestId: 'request-out-of-combat',
      tokenId: 't1',
      mapId: 'map-1',
      position: { x: 1, y: 0 },
      movement: null,
    };
    const rejected: TokenMoveRejectedEvent = {
      requestId: 'request-early-reject',
      tokenId: 't1',
      mapId: 'map-1',
      position: null,
      movement: null,
      error: { code: 'MAP_NOT_FOUND', message: 'Map not found' },
    };

    act(() => created[0].fire('token.move.accepted', accepted));
    act(() => created[0].fire('token.move.rejected', rejected));

    expect(onMoveResponse).toHaveBeenNthCalledWith(1, { ...accepted, accepted: true });
    expect(onMoveResponse).toHaveBeenNthCalledWith(2, { ...rejected, accepted: false });
  });
});
