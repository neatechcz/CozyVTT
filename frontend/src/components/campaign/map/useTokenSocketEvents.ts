// ============================================
// Token socket events for MapCanvas
//
// - `token.moved`: another client dragged a token → tween it to the new
//   position and move it in the store
// - `token.added` / `token.updated` / `token.removed`: tokens changed through
//   the REST API (DM toolbar, AI game master via MCP). The server already
//   filtered hidden tokens out for players, so events are applied as they
//   come; only events for a map other than the displayed one are dropped.
//
// Subscribes through the socket client's `on()` / `off()` (never the raw
// socket.io instance), so the listeners survive the client replacing its
// underlying socket (server-forced reconnect, browser back online).
// ============================================

import { useEffect, useRef, useState } from 'react';
import type {
  Token,
  TokenMoveAcceptedEvent,
  TokenMovePreviewBroadcast,
  TokenMoveRejectedEvent,
  TokenMoveResponse,
  TokenMovedEvent,
} from '@/types';
import { useGameStore } from '@/stores/gameStore';
import type { TokenAnimation } from './layers/types';
import {
  applyTokenEvent,
  type TokenEvent,
  type TokenAddedPayload,
  type TokenUpdatedPayload,
  type TokenRemovedPayload,
} from '@/utils/tokenEvents';

/** The part of `socketClient` the token listeners use */
export interface TokenEventSocket {
  on(event: string, callback: (data: any) => void): void;
  off(event: string, callback?: (data: any) => void): void;
}

export interface TokenSocketEventState {
  /** Other users' temporary positions. These never enter the canonical store. */
  movementPreviews: Record<string, TokenMovePreviewBroadcast>;
}

export function useTokenSocketEvents(
  socket: TokenEventSocket | null | undefined,
  currentMapId: string | undefined,
  /** Seeds a movement tween (`useTokenAnimation`'s `setAnimatingTokens`) */
  startTokenAnimation: (tokenId: string, animation: TokenAnimation) => void,
  onMoveResponse?: (response: TokenMoveResponse) => void,
): TokenSocketEventState {
  const startAnimationRef = useRef(startTokenAnimation);
  startAnimationRef.current = startTokenAnimation;
  const moveResponseRef = useRef(onMoveResponse);
  moveResponseRef.current = onMoveResponse;
  const [movementPreviews, setMovementPreviews] = useState<Record<string, TokenMovePreviewBroadcast>>({});

  useEffect(() => {
    setMovementPreviews({});
  }, [currentMapId]);

  useEffect(() => {
    if (!socket) return;

    const handleTokenMoved = (event: TokenMovedEvent) => {
      // Committed token events carry mapId. Keep compatibility with pre-ledger
      // events that omit it while always rejecting an explicit other-map event.
      if (!currentMapId || (event.mapId && event.mapId !== currentMapId)) return;

      // Read from the store (not a render closure) so rapid events that arrive
      // in the same macro-task all see the most recently mutated state.
      const store = useGameStore.getState();
      const token = store.tokens[event.tokenId];
      if (!token) return;
      const position = event.position ?? { x: event.x, y: event.y };

      // Start animation from current position to new position
      startAnimationRef.current(event.tokenId, {
        fromX: token.position.x,
        fromY: token.position.y,
        toX: position.x,
        toY: position.y,
        startTime: Date.now(),
        duration: 200,
      });

      // Store writes are synchronous — subsequent handlers in the same
      // macro-task (e.g. token:appeared for NPCs) see the correct state.
      store.applyTokenMove(event.tokenId, position);
      setMovementPreviews((previous) => {
        if (!previous[event.tokenId]) return previous;
        const next = { ...previous };
        delete next[event.tokenId];
        return next;
      });
    };

    const handlePreview = (event: TokenMovePreviewBroadcast) => {
      if (!currentMapId || event.mapId !== currentMapId) return;
      setMovementPreviews((previous) => {
        if (!event.preview) {
          if (!previous[event.tokenId]) return previous;
          const next = { ...previous };
          delete next[event.tokenId];
          return next;
        }
        return { ...previous, [event.tokenId]: event };
      });
    };

    const handleAccepted = (event: TokenMoveAcceptedEvent) => {
      // A local move can still be pending when the viewer switches maps. Its
      // request id identifies the owner even after the map-scoped listeners
      // have changed; the caller decides whether this response is still live.
      moveResponseRef.current?.({ ...event, accepted: true });
    };

    const handleRejected = (event: TokenMoveRejectedEvent) => {
      moveResponseRef.current?.({ ...event, accepted: false });
    };

    socket.on('token.moved', handleTokenMoved);
    socket.on('token.move.preview', handlePreview);
    socket.on('token.move.accepted', handleAccepted);
    socket.on('token.move.rejected', handleRejected);
    return () => {
      socket.off('token.moved', handleTokenMoved);
      socket.off('token.move.preview', handlePreview);
      socket.off('token.move.accepted', handleAccepted);
      socket.off('token.move.rejected', handleRejected);
    };
  }, [socket, currentMapId]); // handler reads/writes via the store, no reactive deps needed

  useEffect(() => {
    if (!socket) return;

    const applyEvent = (event: TokenEvent) => {
      if (!currentMapId || event.mapId !== currentMapId) return;
      // Read the live list from the store at event time (never a render
      // closure copy) so rapid events build on each other.
      const store = useGameStore.getState();
      const current = store.tokenOrder.map((id) => store.tokens[id]).filter((t): t is Token => !!t);
      store.setTokens(applyTokenEvent(current, event));
    };

    const handleTokenAdded = (payload: TokenAddedPayload) => applyEvent({ type: 'token.added', ...payload });
    const handleTokenUpdated = (payload: TokenUpdatedPayload) => applyEvent({ type: 'token.updated', ...payload });
    const handleTokenRemoved = (payload: TokenRemovedPayload) => applyEvent({ type: 'token.removed', ...payload });

    socket.on('token.added', handleTokenAdded);
    socket.on('token.updated', handleTokenUpdated);
    socket.on('token.removed', handleTokenRemoved);

    return () => {
      socket.off('token.added', handleTokenAdded);
      socket.off('token.updated', handleTokenUpdated);
      socket.off('token.removed', handleTokenRemoved);
    };
  }, [socket, currentMapId]);

  return { movementPreviews };
}
