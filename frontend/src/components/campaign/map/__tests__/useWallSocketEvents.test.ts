import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEffect, useRef } from 'react';
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

/** Wires the real useWallHistory to useWallSocketEvents exactly the way
 * MapCanvas does: `wallsRef` is kept current by a passive effect (runs after
 * commit), never updated synchronously during render. */
function useHarness(
  mapId: string | undefined,
  isDM: boolean,
  onWallsChanged: () => void,
  initial: WallSegment[] = [],
  onRemoteReset?: () => void,
) {
  const history = useWallHistory(initial);
  const wallsRef = useRef<WallSegment[]>(initial);
  useEffect(() => { wallsRef.current = history.walls; }, [history.walls]);
  useWallSocketEvents(socketClient, mapId, isDM, wallsRef, {
    replaceWalls: history.replace,
    resetWalls: history.reset,
    onWallsChanged,
    onRemoteReset,
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

  it('DM applies a remote wall:updated for a segment it does not have yet (appends instead of dropping it)', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a')]));

    const missing = { ...seg('missing'), type: 'door-open' as const };
    act(() => created[0].fire('wall:updated', {
      mapId: 'map-1',
      segment: missing,
      sourceSocketId: 'some-other-socket',
      changedBy: 'alice',
    }));

    expect(result.current.walls).toEqual([seg('a'), missing]);
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

  // Own echo / unknown origin / other-map guards for the three incremental
  // events too — walls:replaced above is not the only event with these rules.
  describe.each([
    {
      event: 'wall:added',
      basePayload: () => ({ segment: seg('new') }),
      wallsAfterSkip: [seg('a')],
      wallsAfterApply: [seg('a'), seg('new')],
    },
    {
      event: 'wall:removed',
      basePayload: () => ({ segmentId: 'a' }),
      wallsAfterSkip: [seg('a')],
      wallsAfterApply: [],
    },
    {
      event: 'wall:updated',
      basePayload: () => ({ segment: { ...seg('a'), type: 'door-open' as const } }),
      wallsAfterSkip: [seg('a')],
      wallsAfterApply: [{ ...seg('a'), type: 'door-open' as const }],
    },
  ])('$event own-echo / unknown-origin / other-map guards', ({ event, basePayload, wallsAfterSkip, wallsAfterApply }) => {
    it('DM skips its own echo', async () => {
      await connectAndHandshake();
      const onWallsChanged = vi.fn();
      const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a')]));
      const myId = created[0].id;

      act(() => created[0].fire(event, { mapId: 'map-1', ...basePayload(), sourceSocketId: myId, changedBy: 'me' }));

      expect(result.current.walls).toEqual(wallsAfterSkip);
      expect(onWallsChanged).not.toHaveBeenCalled();
    });

    it('DM skips an unknown-origin event; a player applies it', async () => {
      await connectAndHandshake();
      const dmChanged = vi.fn();
      const dm = renderHook(() => useHarness('map-1', true, dmChanged, [seg('a')]));
      act(() => created[0].fire(event, { mapId: 'map-1', ...basePayload() }));
      expect(dm.result.current.walls).toEqual(wallsAfterSkip);
      expect(dmChanged).not.toHaveBeenCalled();

      const playerChanged = vi.fn();
      const player = renderHook(() => useHarness('map-1', false, playerChanged, [seg('a')]));
      act(() => created[0].fire(event, { mapId: 'map-1', ...basePayload() }));
      expect(playerChanged).toHaveBeenCalledTimes(1);
      expect(player.result.current.walls).toEqual(wallsAfterApply);
    });

    it('ignores the event for another map', async () => {
      await connectAndHandshake();
      const onWallsChanged = vi.fn();
      const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('a')]));

      act(() => created[0].fire(event, { mapId: 'map-2', ...basePayload(), sourceSocketId: 'other', changedBy: 'other-dm' }));

      expect(result.current.walls).toEqual(wallsAfterSkip);
      expect(onWallsChanged).not.toHaveBeenCalled();
    });
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

  it('calls onRemoteReset only for an authoritative remote change, not for an unknown-origin player apply', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const onRemoteReset = vi.fn();
    const player = renderHook(() => useHarness('map-1', false, onWallsChanged, [seg('a')], onRemoteReset));

    act(() => created[0].fire('walls:replaced', { mapId: 'map-1', segments: [seg('a'), seg('b')] }));
    expect(player.result.current.walls).toEqual([seg('a'), seg('b')]);
    expect(onRemoteReset).not.toHaveBeenCalled();

    act(() => created[0].fire('walls:replaced', {
      mapId: 'map-1',
      segments: [seg('z')],
      sourceSocketId: 'some-other-socket',
      changedBy: 'other-dm',
    }));
    expect(onRemoteReset).toHaveBeenCalledTimes(1);
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

  // The stale-ref race: two or three remote events delivered back to back in
  // the same tick, before React re-renders (and this harness's passive
  // effect updates wallsRef). Each handler must compose on top of the
  // *previous handler's* result, not a render-time snapshot.
  describe('consecutive events in one tick (stale-ref race)', () => {
    it('a remote split (remove + 2× add) applies all three changes', async () => {
      await connectAndHandshake();
      const { result } = renderHook(() => useHarness('map-1', true, vi.fn(), [seg('h'), seg('w')]));

      act(() => {
        created[0].fire('wall:removed', { mapId: 'map-1', segmentId: 'h', sourceSocketId: 'other' });
        created[0].fire('wall:added', { mapId: 'map-1', segment: seg('a'), sourceSocketId: 'other' });
        created[0].fire('wall:added', { mapId: 'map-1', segment: seg('b'), sourceSocketId: 'other' });
      });

      expect(result.current.walls.map((s) => s.id)).toEqual(['w', 'a', 'b']);
    });

    it('a remote walls:replaced immediately followed by a remote wall:updated keeps the replace', async () => {
      await connectAndHandshake();
      const door = { ...seg('d'), type: 'door-closed' as const };
      const { result } = renderHook(() => useHarness('map-1', true, vi.fn(), [seg('old'), door]));

      act(() => {
        created[0].fire('walls:replaced', {
          mapId: 'map-1',
          segments: [seg('room1'), seg('room2'), door],
          sourceSocketId: 'mcp',
        });
        created[0].fire('wall:updated', {
          mapId: 'map-1',
          segment: { ...door, type: 'door-open' as const },
          sourceSocketId: 'mcp',
        });
      });

      expect(result.current.walls.map((s) => s.id)).toEqual(['room1', 'room2', 'd']);
      expect(result.current.walls.find((s) => s.id === 'd')?.type).toBe('door-open');
    });
  });

  // sync: true (the walls:request reply) is an authoritative resync: unlike
  // an ordinary origin-less broadcast, a DM must apply it too.
  it('DM applies a sync:true walls:replaced (the walls:request reply) even though it has no sourceSocketId', async () => {
    await connectAndHandshake();
    const onWallsChanged = vi.fn();
    const { result } = renderHook(() => useHarness('map-1', true, onWallsChanged, [seg('stale')]));

    act(() => created[0].fire('walls:replaced', { mapId: 'map-1', segments: [seg('a'), seg('b')], sync: true }));

    expect(result.current.walls).toEqual([seg('a'), seg('b')]);
    expect(onWallsChanged).toHaveBeenCalledTimes(1);
  });

  it('a sync:true reply resets undo/redo like any other authoritative change', async () => {
    await connectAndHandshake();
    const { result } = renderHook(() => useHarness('map-1', true, vi.fn(), [seg('a')]));

    act(() => result.current.push([seg('a'), seg('b')]));
    expect(result.current.canUndo).toBe(true);

    act(() => created[0].fire('walls:replaced', { mapId: 'map-1', segments: [seg('z')], sync: true }));

    expect(result.current.canUndo).toBe(false);
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

  it('reads the socket id at event time: the old socket\'s id is a remote id, the new one\'s is the own-echo id', async () => {
    await connectAndHandshake();
    const { result } = renderHook(() => useHarness('map-1', true, vi.fn(), [seg('a')]));
    const oldId = created[0].id;

    created[0].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(3000);
    expect(created).toHaveLength(2);
    handshake(created[1]);
    const newId = created[1].id;
    expect(newId).not.toBe(oldId);

    // The new socket's own id is now this client's id — an event claiming
    // to come from it is treated as this client's own echo and skipped.
    act(() => created[1].fire('walls:replaced', { mapId: 'map-1', segments: [seg('x')], sourceSocketId: newId }));
    expect(result.current.walls).toEqual([seg('a')]);

    // The old (no-longer-current) socket's id is now a *remote* id — an
    // event claiming to come from it is applied, proving the id is read
    // live at event time, not captured once at subscription time.
    act(() => created[1].fire('walls:replaced', { mapId: 'map-1', segments: [seg('y')], sourceSocketId: oldId }));
    expect(result.current.walls).toEqual([seg('y')]);
  });

  it('re-requests the current map\'s walls after a reconnect', async () => {
    await connectAndHandshake();
    renderHook(() => useHarness('map-1', true, vi.fn(), [seg('a')]));

    created[0].fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(3000);
    expect(created).toHaveLength(2);
    handshake(created[1]);

    const requests = created[1].emitted.filter((e) => e.event === 'walls:request');
    expect(requests).toEqual([{ event: 'walls:request', payload: { mapId: 'map-1' } }]);
  });

  it('does not request walls on the very first connect (only after an actual reconnect)', async () => {
    await connectAndHandshake();
    renderHook(() => useHarness('map-1', true, vi.fn(), [seg('a')]));

    const requests = created[0].emitted.filter((e) => e.event === 'walls:request');
    expect(requests).toEqual([]);
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
