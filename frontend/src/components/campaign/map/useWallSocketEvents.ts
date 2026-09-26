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
//   underlying socket id, read at event time — never captured once at
//   subscription time, since the client can replace its socket mid-session):
//   skip, already applied optimistically.
// - Unknown origin (`sourceSocketId` absent — an older backend): DM keeps
//   the old behaviour and skips it (its own edits were already applied); a
//   player applies it, same as before.
// - `sync: true` (only ever set on the `walls:request` reply): an
//   authoritative resync — e.g. after this client reconnects and may have
//   missed broadcasts while offline. Unlike an ordinary origin-less event,
//   this is applied for DM and player alike; a DM skipping it would keep
//   stale walls indefinitely after being offline.
// - Remote change (`sourceSocketId` present and different) or a `sync`
//   reply: apply for DMs and players alike, and reset the undo/redo
//   history — those entries predate the change; leaving them would let an
//   undo resurrect stale walls and re-broadcast them, erasing the change
//   for everyone.
//
// `replaceWalls` / `resetWalls` are always called with an *updater*
// `(current) => next`, resolved by `useWallHistory` inside its own
// `setWs(prev => ...)` functional update — never with a value computed here
// from a "live walls" ref. Multiple wall events can be delivered back to
// back in the same macrotask (e.g. a co-DM's wall split: remove + 2× add, or
// the MCP narrator's `walls:replace` immediately followed by a door toggle)
// — all before React re-renders and any ref tracking "current walls" is
// updated. Computing each handler's result from such a ref would make every
// handler but the first act on a stale snapshot and silently drop the
// others' effect (reproduced: a remote split landed as `[h, w, b]` instead
// of `[w, a, b]`, and a replace-then-update lost the whole replace). The
// updater form is immune to this because each call resolves against the
// *previous call's already-applied result*, not a render-time value.
//
// Known limitation: this client's own in-flight wall edit (submitted but not
// yet echoed back) is not merged against a remote change landing in the
// meantime — `walls:replace` always sends the *full* list, so whichever
// write reaches the server last simply overwrites the other, and this
// client's canvas can show something slightly different from the server
// until the next resync. Closing that gap needs a per-map wall version (like
// the map-version checks used elsewhere) or an in-flight-edit counter; out
// of scope here.
//
// Subscribes through the socket client's `on()` / `off()` (never the raw
// socket.io instance), so the listeners survive the client replacing its
// underlying socket (server-forced reconnect, browser back online). Also
// subscribes to the socket client's own reconnect signal (`onLifecycle`) —
// the same one CampaignPage uses to refetch the current map over REST after
// a drop — to re-request this map's walls once reconnected: the live event
// stream only pushes deltas, so any wall edits broadcast while this client
// was offline would otherwise be missed entirely, leaving a stale list that
// the next local edit would erase.
// ============================================

import { useEffect, useRef, type RefObject } from 'react';
import type {
  WallSegment,
  WallAddedEvent,
  WallRemovedEvent,
  WallUpdatedEvent,
  WallsReplacedEvent,
} from '@/types/walls';
import type { WallsUpdate } from '@/hooks/useWallHistory';

/** The part of `socketClient` the wall listeners use. */
export interface WallEventSocket {
  on(event: string, callback: (data: any) => void): void;
  off(event: string, callback?: (data: any) => void): void;
  /** Current underlying socket — read at event time for its (possibly just replaced) `id`, and to emit `walls:request` after a reconnect. */
  getSocket(): { id?: string; emit(event: string, payload?: unknown): void } | null | undefined;
  /**
   * Client-level connection signal (not a server event): fires 'disconnected'
   * on a drop, then 'authenticated' once the (possibly newly built) socket
   * has rejoined the campaign. Returns an unsubscribe function.
   */
  onLifecycle(listener: (event: string, detail?: any) => void): () => void;
}

export interface WallSocketActions {
  /** Restore walls without touching undo/redo (unknown-origin event, existing behaviour). Accepts an updater. */
  replaceWalls: (next: WallsUpdate) => void;
  /** Restore walls and drop undo/redo (a confirmed remote change or an authoritative sync). Accepts an updater. */
  resetWalls: (next: WallsUpdate) => void;
  /** Invalidate the cached wall render, e.g. `wallCacheValidRef.current = false`. Called for every applied event. */
  onWallsChanged: () => void;
  /**
   * Called only when `resetWalls` is used for an authoritative remote/sync
   * change (never for the unknown-origin `replaceWalls` path). Lets the
   * caller invalidate anything that could otherwise resurrect pre-remote
   * state — e.g. an in-progress wall-endpoint drag's captured pre-drag
   * snapshot, which would otherwise overwrite the just-applied remote change
   * on mouseup.
   */
  onRemoteReset?: () => void;
}

export function useWallSocketEvents(
  socket: WallEventSocket | null | undefined,
  currentMapId: string | undefined,
  isDM: boolean,
  /**
   * Unused by this hook's own merge logic (see the updater note above) —
   * kept in the signature so MapCanvas's existing `wallSegmentsRef` (used
   * elsewhere for other purposes) can still be passed through without a
   * second, redundant ref.
   */
  _wallsRef: RefObject<WallSegment[]>,
  actions: WallSocketActions,
) {
  const isDMRef = useRef(isDM);
  isDMRef.current = isDM;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const currentMapIdRef = useRef(currentMapId);
  currentMapIdRef.current = currentMapId;

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

      if (!data.sourceSocketId) {
        if (isDMRef.current) return; // unknown origin, DM: skip (today's behaviour)
        actionsRef.current.replaceWalls((current) => [...current, data.segment]);
      } else {
        actionsRef.current.resetWalls((current) =>
          current.some((s) => s.id === data.segment.id) ? current : [...current, data.segment]
        );
        actionsRef.current.onRemoteReset?.();
      }
      actionsRef.current.onWallsChanged();
    };

    const handleWallRemoved = (data: WallRemovedEvent) => {
      if (!currentMapId || data.mapId !== currentMapId) return;
      if (isOwnEcho(data.sourceSocketId)) return;

      if (!data.sourceSocketId) {
        if (isDMRef.current) return;
        actionsRef.current.replaceWalls((current) => current.filter((s) => s.id !== data.segmentId));
      } else {
        actionsRef.current.resetWalls((current) => current.filter((s) => s.id !== data.segmentId));
        actionsRef.current.onRemoteReset?.();
      }
      actionsRef.current.onWallsChanged();
    };

    const handleWallUpdated = (data: WallUpdatedEvent) => {
      if (!currentMapId || data.mapId !== currentMapId) return;
      if (isOwnEcho(data.sourceSocketId)) return;

      if (!data.sourceSocketId) {
        if (isDMRef.current) return;
        actionsRef.current.replaceWalls((current) => current.map((s) => (s.id === data.segment.id ? data.segment : s)));
      } else {
        actionsRef.current.resetWalls((current) => {
          const exists = current.some((s) => s.id === data.segment.id);
          return exists
            ? current.map((s) => (s.id === data.segment.id ? data.segment : s))
            : [...current, data.segment];
        });
        actionsRef.current.onRemoteReset?.();
      }
      actionsRef.current.onWallsChanged();
    };

    const handleWallsReplaced = (data: WallsReplacedEvent) => {
      if (!currentMapId || data.mapId !== currentMapId) return;
      if (isOwnEcho(data.sourceSocketId)) return;

      if (data.sync) {
        // Authoritative resync (the walls:request reply after a reconnect) — apply for everyone.
        actionsRef.current.resetWalls(data.segments);
        actionsRef.current.onRemoteReset?.();
      } else if (!data.sourceSocketId) {
        if (isDMRef.current) return;
        actionsRef.current.replaceWalls(data.segments);
      } else {
        actionsRef.current.resetWalls(data.segments);
        actionsRef.current.onRemoteReset?.();
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
  }, [socket, currentMapId]);

  // Re-request the current map's walls after a genuine reconnect (a drop
  // followed by rejoining), never on the very first connect — mirrors
  // CampaignPage's `reconnectCount`, which ticks the same way for the same
  // reason (REST resync of anything missed while offline), but through the
  // socket client's own lifecycle signal so it works independently of that
  // React state.
  useEffect(() => {
    if (!socket || typeof socket.onLifecycle !== 'function') return;

    let awaitingReconnect = false;
    return socket.onLifecycle((event) => {
      if (event === 'disconnected') {
        awaitingReconnect = true;
      } else if (event === 'authenticated' && awaitingReconnect) {
        awaitingReconnect = false;
        const mapId = currentMapIdRef.current;
        if (mapId) socket.getSocket()?.emit('walls:request', { mapId });
      }
    });
  }, [socket]);
}
