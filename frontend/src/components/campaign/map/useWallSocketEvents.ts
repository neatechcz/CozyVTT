// ============================================
// Wall socket events for MapCanvas
//
// wall:added / wall:removed / wall:updated / walls:replaced carry an origin
// (`sourceSocketId`, `changedBy`) so a client can tell its own optimistic
// echo from a change made by another client — another DM socket, the AI
// narrator's MCP service account (which now edits walls too), or a player
// toggling an unlocked door. Rules:
//
// - Own echo (`sourceSocketId` present and equal to this client's current
//   underlying socket id): skip — already applied optimistically.
// - Unknown origin (`sourceSocketId` absent — an older backend, or the
//   `walls:request` reply): DM keeps the old behaviour and skips it (its own
//   edits were already applied); a player applies it, same as before.
// - Remote change (`sourceSocketId` present and different): apply for DMs
//   and players alike, and reset the undo/redo history — those entries
//   predate the remote change; leaving them would let an undo resurrect
//   stale walls and re-broadcast them, erasing the remote change for
//   everyone.
//
// Subscribes through the socket client's `on()` / `off()` (never the raw
// socket.io instance), so the listeners survive the client replacing its
// underlying socket (server-forced reconnect, browser back online).
// ============================================

import { useEffect, useRef, type RefObject } from 'react';
import type {
  WallSegment,
  WallAddedEvent,
  WallRemovedEvent,
  WallUpdatedEvent,
  WallsReplacedEvent,
} from '@/types/walls';

/** The part of `socketClient` the wall listeners use. */
export interface WallEventSocket {
  on(event: string, callback: (data: any) => void): void;
  off(event: string, callback?: (data: any) => void): void;
  /** Current underlying socket — read at event time for its (possibly just replaced) `id`. */
  getSocket(): { id?: string } | null | undefined;
}

export interface WallSocketActions {
  /** Restore walls without touching undo/redo (today's behaviour for an unknown-origin event). */
  replaceWalls: (next: WallSegment[]) => void;
  /** Restore walls and drop undo/redo (a confirmed remote change). */
  resetWalls: (next: WallSegment[]) => void;
  /** Invalidate the cached wall render, e.g. `wallCacheValidRef.current = false`. */
  onWallsChanged: () => void;
}

export function useWallSocketEvents(
  socket: WallEventSocket | null | undefined,
  currentMapId: string | undefined,
  isDM: boolean,
  /** Live wall list — read at event time, never a render closure. Kept current by the caller. */
  wallsRef: RefObject<WallSegment[]>,
  actions: WallSocketActions,
) {
  const isDMRef = useRef(isDM);
  isDMRef.current = isDM;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!socket) return;

    /** This client made the change itself — already applied optimistically. */
    const isOwnEcho = (sourceSocketId?: string): boolean => {
      if (!sourceSocketId) return false;
      const myId = socket.getSocket()?.id;
      return !!myId && sourceSocketId === myId;
    };

    const handleWallAdded = (data: WallAddedEvent) => {
      if (!currentMapId || data.mapId !== currentMapId) return;
      if (isOwnEcho(data.sourceSocketId)) return;
      const current = wallsRef.current ?? [];

      if (!data.sourceSocketId) {
        if (isDMRef.current) return; // unknown origin, DM: skip (today's behaviour)
        actionsRef.current.replaceWalls([...current, data.segment]);
      } else {
        const next = current.some((s) => s.id === data.segment.id) ? current : [...current, data.segment];
        actionsRef.current.resetWalls(next);
      }
      actionsRef.current.onWallsChanged();
    };

    const handleWallRemoved = (data: WallRemovedEvent) => {
      if (!currentMapId || data.mapId !== currentMapId) return;
      if (isOwnEcho(data.sourceSocketId)) return;
      const current = wallsRef.current ?? [];
      const next = current.filter((s) => s.id !== data.segmentId);

      if (!data.sourceSocketId) {
        if (isDMRef.current) return;
        actionsRef.current.replaceWalls(next);
      } else {
        actionsRef.current.resetWalls(next);
      }
      actionsRef.current.onWallsChanged();
    };

    const handleWallUpdated = (data: WallUpdatedEvent) => {
      if (!currentMapId || data.mapId !== currentMapId) return;
      if (isOwnEcho(data.sourceSocketId)) return;
      const current = wallsRef.current ?? [];

      if (!data.sourceSocketId) {
        if (isDMRef.current) return;
        actionsRef.current.replaceWalls(current.map((s) => (s.id === data.segment.id ? data.segment : s)));
      } else {
        const exists = current.some((s) => s.id === data.segment.id);
        const next = exists
          ? current.map((s) => (s.id === data.segment.id ? data.segment : s))
          : [...current, data.segment];
        actionsRef.current.resetWalls(next);
      }
      actionsRef.current.onWallsChanged();
    };

    const handleWallsReplaced = (data: WallsReplacedEvent) => {
      if (!currentMapId || data.mapId !== currentMapId) return;
      if (isOwnEcho(data.sourceSocketId)) return;

      if (!data.sourceSocketId) {
        if (isDMRef.current) return;
        actionsRef.current.replaceWalls(data.segments);
      } else {
        actionsRef.current.resetWalls(data.segments);
      }
      actionsRef.current.onWallsChanged();
    };

    socket.on('wall:added', handleWallAdded);
    socket.on('wall:removed', handleWallRemoved);
    socket.on('wall:updated', handleWallUpdated);
    socket.on('walls:replaced', handleWallsReplaced);

    return () => {
      socket.off('wall:added', handleWallAdded);
      socket.off('wall:removed', handleWallRemoved);
      socket.off('wall:updated', handleWallUpdated);
      socket.off('walls:replaced', handleWallsReplaced);
    };
  }, [socket, currentMapId, wallsRef]);
}
