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

import { useEffect, useRef } from 'react';
import type { Token, TokenMovedEvent } from '@/types';
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

export function useTokenSocketEvents(
  socket: TokenEventSocket | null | undefined,
  currentMapId: string | undefined,
  /** Seeds a movement tween (`useTokenAnimation`'s `setAnimatingTokens`) */
  startTokenAnimation: (tokenId: string, animation: TokenAnimation) => void,
) {
  const startAnimationRef = useRef(startTokenAnimation);
  startAnimationRef.current = startTokenAnimation;

  useEffect(() => {
    if (!socket) return;

    const handleTokenMoved = (event: TokenMovedEvent) => {
      // Read from the store (not a render closure) so rapid events that arrive
      // in the same macro-task all see the most recently mutated state.
      const store = useGameStore.getState();
      const token = store.tokens[event.tokenId];
      if (!token) return;

      // Start animation from current position to new position
      startAnimationRef.current(event.tokenId, {
        fromX: token.position.x,
        fromY: token.position.y,
        toX: event.x,
        toY: event.y,
        startTime: Date.now(),
        duration: 200,
      });

      // Store writes are synchronous — subsequent handlers in the same
      // macro-task (e.g. token:appeared for NPCs) see the correct state.
      store.applyTokenMove(event.tokenId, { x: event.x, y: event.y });
    };

    socket.on('token.moved', handleTokenMoved);
    return () => {
      socket.off('token.moved', handleTokenMoved);
    };
  }, [socket]); // handler reads/writes via the store, no reactive deps needed

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
}
