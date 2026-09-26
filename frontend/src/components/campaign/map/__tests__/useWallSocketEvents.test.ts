import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { createdSockets as created, handshake } from '@/test/fakeSocketIo';
import { socketClient } from '@/services/socket';
import { useWallHistory } from '@/hooks/useWallHistory';
import type { WallSegment } from '@/types/walls';
import { useWallSocketEvents } from '../useWallSocketEvents';

// A remote wall change (another DM socket, the AI narrator's MCP service
// account, or a player toggling an unlocked door) must reach the DM's canvas,
// and never be confused with the DM's own optimistic echo of its own edit.

vi.mock('socket.io-client', async () => (await import('@/test/fakeSocketIo')).fakeSocketIoModule);

const seg = (id: string, x2 = 100): WallSegment => ({ id, x1: 0, y1: 0, x2, y2: 0, type: 'wall' });

/** Wires the real useWallHistory to useWallSocketEvents, the way MapCanvas does:
 * a ref kept current via effect, history's replace/reset as the write path. */
function useHarness(mapId: string | undefined, isDM: boolean, onWallsChanged: () => void, initial: WallSegment[] = []) {
  const history = useWallHistory(initial);
  const wallsRef = useRef<WallSegment[]>(initial);
  wallsRef.current = history.walls;
  useWallSocketEvents(socketClient, mapId, isDM, wallsRef, {
    replaceWalls: history.replace,
    resetWalls: history.reset,
    onWallsChanged,
  });
  return history;
}

beforeEach(() => {
  created.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  socketClient.disconnect();
  vi.useRealTimers();
});

async function connectAndHandshake() {
  const connecting = socketClient.connect('camp-1');
  handshake(created[0]);
  await connecting;
}

describe('MapCanvas wall socket listeners', () => {
  it('DM applies a remote walls:replaced (different sourceSocketId)', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a')]));

    act(() => created[0].fire('walls:replaced', {
      mapId: 'map-1',
      segments: [seg('a'), seg('b')],
      sourceSocketId: 'some-other-socket',
      changedBy: 'other-dm',
    }));

    expect(result.current.walls).toEqual([seg('a'), seg('b')]);
    expect(onWallsChanged).toHaveBeenCalledTimes(1);
  });

  it('DM applies a remote wall:updated (different sourceSocketId)', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a')]));

    const updated = { ...seg('a'), type: 'door-open' as const };
    act(() => created[0].fire('wall:updated', {
      mapId: 'map-1',
      segment: updated,
      sourceSocketId: 'some-other-socket',
      changedBy: 'alice',
    }));

    expect(result.current.walls).toEqual([updated]);
    expect(onWallsChanged).toHaveBeenCalledTimes(1);
  });

  it('DM applies a remote wall:added (different sourceSocketId, appends if not already present)', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a')]));

    act(() => created[0].fire('wall:added', {
      mapId: 'map-1',
      segment: seg('b'),
      sourceSocketId: 'some-other-socket',
      changedBy: 'other-dm',
    }));
    expect(result.current.walls).toEqual([seg('a'), seg('b')]);

    // Already present (e.g. redelivered) — not appended twice.
    act(() => created[0].fire('wall:added', {
      mapId: 'map-1',
      segment: seg('b'),
      sourceSocketId: 'some-other-socket',
      changedBy: 'other-dm',
    }));
    expect(result.current.walls).toEqual([seg('a'), seg('b')]);
  });

  it('DM applies a remote wall:removed (different sourceSocketId)', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a'), seg('b')]));

    act(() => created[0].fire('wall:removed', {
      mapId: 'map-1',
      segmentId: 'a',
      sourceSocketId: 'some-other-socket',
      changedBy: 'other-dm',
    }));

    expect(result.current.walls).toEqual([seg('b')]);
    expect(onWallsChanged).toHaveBeenCalledTimes(1);
  });

  it('DM skips its own echo (sourceSocketId equal to this client\'s current socket id)', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a')]));
    const myId = created[0].id;

    act(() => created[0].fire('walls:replaced', {
      mapId: 'map-1',
      segments: [seg('a'), seg('b')],
      sourceSocketId: myId,
      changedBy: 'me',
    }));

    expect(result.current.walls).toEqual([seg('a')]);
    expect(onWallsChanged).not.toHaveBeenCalled();
  });

  it('DM skips unknown-origin events (no sourceSocketId); player applies them', async () => {
    await connectAndHandshake();

    const dmChanged = vi.fn();
    const dm = renderHook(() => useHarness('map-1', true, dmChanged, [seg('a')]));
    act(() => created[0].fire('walls:replaced', { mapId: 'map-1', segments: [seg('a'), seg('b')] }));
    expect(dm.result.current.walls).toEqual([seg('a')]);
    expect(dmChanged).not.toHaveBeenCalled();

    const playerChanged = vi.fn();
    const player = renderHook(() => useHarness('map-1', false, playerChanged, [seg('a')]));
    act(() => created[0].fire('walls:replaced', { mapId: 'map-1', segments: [seg('a'), seg('b')] }));
    expect(player.result.current.walls).toEqual([seg('a'), seg('b')]);
    expect(playerChanged).toHaveBeenCalledTimes(1);
  });

  it('a remote change resets undo/redo history (predates the remote change)', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a')]));

    act(() => result.current.push([seg('a'), seg('b')]));
    expect(result.current.canUndo).toBe(true);

    act(() => created[0].fire('walls:replaced', {
      mapId: 'map-1',
      segments: [seg('z')],
      sourceSocketId: 'some-other-socket',
      changedBy: 'other-dm',
    }));

    expect(result.current.walls).toEqual([seg('z')]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('events for another map are ignored', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a')]));

    act(() => created[0].fire('walls:replaced', {
      mapId: 'map-2',
      segments: [seg('a'), seg('b')],
      sourceSocketId: 'some-other-socket',
      changedBy: 'other-dm',
    }));

    expect(result.current.walls).toEqual([seg('a')]);
    expect(onWallsChanged).not.toHaveBeenCalled();
  });

  it('keeps receiving wall events after the socket client replaces its socket', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a')]));

    created[0].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(3000);
    expect(created).toHaveLength(2);
    handshake(created[1]);

    act(() => created[1].fire('walls:replaced', {
      mapId: 'map-1',
      segments: [seg('a'), seg('b')],
      sourceSocketId: 'some-other-socket',
      changedBy: 'other-dm',
    }));

    expect(result.current.walls).toEqual([seg('a'), seg('b')]);
  });

  it('unmount unsubscribes all four wall listeners', async () => {
    await connectAndHandshake();
    const hook = renderHook(() => useHarness('map-1', true, vi.fn(), [seg('a')]));

    hook.unmount();

    expect(created[0].listenerCount('wall:added')).toBe(0);
    expect(created[0].listenerCount('wall:removed')).toBe(0);
    expect(created[0].listenerCount('wall:updated')).toBe(0);
    expect(created[0].listenerCount('walls:replaced')).toBe(0);
  });
});
