// ============================================
// Token movement handlers
// token.move.start / token.move (throttled) / token.move.end
// ============================================

import { Server } from 'socket.io';
import { throttle } from 'lodash';
import { AuthenticatedSocket } from '../auth';
import { prisma } from '../../config/database';
import {
  diffTokenViews,
  filterTokensForViewer,
  getSpiritVisibility,
  getSpiritVisibilityBatch,
  type TokenViewMap,
} from '../../utils/spirit-layer';
import logger from '../../utils/logger';
import { Token, tokenMoveLimiter } from '../shared';

/** One socket in the campaign room with the inputs of its token view. */
interface TokenViewer {
  socket: { id: string; emit: (event: string, payload: unknown) => unknown };
  isDM: boolean;
  role: string;
  userId?: string;
  spiritVisible: boolean;
}

/** Every socket in the campaign room, with its role and spirit-layer visibility. */
async function getTokenViewers(io: Server, campaignId: string): Promise<TokenViewer[]> {
  const campaignSockets = await io.in(campaignId).fetchSockets();
  const authed = campaignSockets.map((s) => s as unknown as AuthenticatedSocket);
  const visibility = authed.some((s) => s.role !== 'DM' && s.userId)
    ? await getSpiritVisibilityBatch(
        campaignId,
        authed.map((s) => s.userId).filter((id): id is string => !!id)
      )
    : new Map<string, boolean>();
  return campaignSockets.map((s, i) => ({
    socket: s,
    isDM: authed[i].role === 'DM',
    role: authed[i].role ?? 'SPECTATOR',
    userId: authed[i].userId,
    spiritVisible: !!(authed[i].userId && visibility.get(authed[i].userId!)),
  }));
}

/**
 * A viewer's filtered view of a token array (filterTokensForViewer: role and
 * spirit plane, then line of sight on lighting maps), memoised per
 * (array, role, plane, user) so a user's sockets share one computation.
 */
function tokenViewCache(map: TokenViewMap) {
  const cache = new Map<unknown[], Map<string, Token[]>>();
  return (tokens: Token[], viewer: TokenViewer): Token[] => {
    let byViewer = cache.get(tokens);
    if (!byViewer) cache.set(tokens, (byViewer = new Map()));
    const key = `${viewer.role}|${viewer.spiritVisible}|${viewer.userId ?? ''}`;
    let view = byViewer.get(key);
    if (!view) {
      view = filterTokensForViewer(tokens, map, viewer.role, viewer.spiritVisible, viewer.userId) as unknown as Token[];
      byViewer.set(key, view);
    }
    return view;
  };
}

/**
 * Emit a token-scoped event (`token.move.start`, `token.moved`) to the DMs
 * and to every other socket whose view of `tokens` contains the token — the
 * same per-recipient rules as map.changed. A visible material-plane token on
 * a map without dynamic lighting goes to the whole room (every player sees it
 * there), which keeps the per-frame drag path free of per-socket work.
 */
async function emitToTokenViewers(
  io: Server,
  sender: AuthenticatedSocket,
  map: TokenViewMap,
  tokens: Token[],
  tokenId: string,
  event: string,
  payload: unknown,
  { excludeSender }: { excludeSender: boolean }
): Promise<void> {
  const campaignId = sender.campaignId!;
  const token = tokens.find((t) => t.id === tokenId);
  if (!map.lightingEnabled && token && token.visible && token.layer === 'token') {
    (excludeSender ? sender.to(campaignId) : io.to(campaignId)).emit(event, payload);
    return;
  }

  const view = tokenViewCache(map);
  for (const viewer of await getTokenViewers(io, campaignId)) {
    if (excludeSender && viewer.socket.id === sender.id) continue;
    if (viewer.isDM || view(tokens, viewer).some((t) => t.id === tokenId)) {
      viewer.socket.emit(event, payload);
    }
  }
}

export function registerTokenHandlers(io: Server, socket: AuthenticatedSocket): void {
  /**
   * TOKEN.MOVE.START - User begins dragging a token
   * Validates permission and broadcasts to campaign
   */
  socket.on('token.move.start', async (data: { tokenId: string; mapId: string }) => {
    try {
      if (!socket.campaignId) {
        socket.emit('error', { message: 'Not authenticated to a campaign' });
        return;
      }

      const { tokenId, mapId } = data;

      if (!tokenId || !mapId) {
        socket.emit('error', { message: 'tokenId and mapId required' });
        return;
      }

      // Fetch the map
      const map = await prisma.map.findUnique({
        where: { id: mapId },
      });

      if (!map || map.campaignId !== socket.campaignId) {
        socket.emit('error', { message: 'Map not found' });
        return;
      }

      // Get tokens array
      const tokensArray = (Array.isArray(map.tokens) ? map.tokens : []) as unknown as Token[];
      const token = tokensArray.find((t) => t.id === tokenId);

      if (!token) {
        socket.emit('error', { message: 'Token not found' });
        return;
      }

      // Permission check: DM can move any token, players can only move their own
      if (socket.role !== 'DM' && token.controlledBy !== socket.userId) {
        socket.emit('error', { message: 'You do not have permission to move this token' });
        return;
      }

      // Spectators cannot move tokens (already handled by controlledBy check, but explicit)
      if (socket.role === 'SPECTATOR') {
        socket.emit('error', { message: 'Spectators cannot move tokens' });
        return;
      }

      // Spirit layer check: non-DMs cannot interact with spirit tokens when spirit layer is disabled
      if (token.layer === 'spirit' && socket.role !== 'DM') {
        const spiritVisible = await getSpiritVisibility(socket.campaignId, socket.userId!);
        if (!spiritVisible) {
          socket.emit('error', { message: 'You cannot interact with spirit layer tokens' });
          return;
        }
      }

      // Only DMs and sockets that can see the token learn that it is being dragged.
      await emitToTokenViewers(
        io,
        socket,
        map,
        tokensArray,
        tokenId,
        'token.move.start',
        { tokenId, mapId, movedBy: socket.userId },
        { excludeSender: true }
      );

      logger.debug('token.move.start', { tokenId, userId: socket.userId, mapId });
    } catch (error) {
      logger.error('token.move.start failed', { err: error });
      socket.emit('error', { message: 'Failed to start token movement' });
    }
  });

  /**
   * TOKEN.MOVE - Position updates during drag (throttled to 60/s)
   * Validates coordinates and broadcasts to campaign
   */
  const handleTokenMove = throttle(async (socket: AuthenticatedSocket, data: { tokenId: string; mapId: string; x: number; y: number }) => {
    try {
      if (!socket.campaignId) {
        return; // Silently ignore if not authenticated
      }

      // Flood ceiling: drop excess frames silently — the 16ms throttle
      // already paces legitimate drags well under this limit.
      if (!tokenMoveLimiter.check(socket.id, 150, 1000)) {
        return;
      }

      const { tokenId, mapId, x, y } = data;

      if (!tokenId || !mapId || typeof x !== 'number' || typeof y !== 'number') {
        return; // Silently ignore invalid data during rapid updates
      }

      // Single fetch covers bounds validation AND the spirit-layer check below
      // (this handler fires up to ~60×/s during a drag, so one query per frame
      // instead of two is the meaningful per-frame win).
      const map = await prisma.map.findUnique({
        where: { id: mapId },
        select: {
          width: true,
          height: true,
          gridSize: true,
          campaignId: true,
          tokens: true,
          lightingEnabled: true,
          wallSegments: true,
          lights: true,
        },
      });

      if (!map || map.campaignId !== socket.campaignId) {
        return; // Silently ignore invalid map during rapid updates
      }

      // Validate coordinates are within map bounds
      if (x < 0 || x >= map.width || y < 0 || y >= map.height) {
        socket.emit('error', { message: 'Token position out of bounds' });
        return;
      }

      // The frame's position decides who sees it (line of sight on lighting maps).
      const storedTokens = (Array.isArray(map.tokens) ? map.tokens : []) as unknown as Token[];
      const frameTokens = storedTokens.map((t) => (t.id === tokenId ? { ...t, position: { x, y } } : t));
      await emitToTokenViewers(
        io,
        socket,
        map,
        frameTokens,
        tokenId,
        'token.moved',
        { tokenId, mapId, x, y, movedBy: socket.userId },
        { excludeSender: true }
      );
    } catch (error) {
      logger.error('token.move failed', { err: error });
    }
  }, 16); // 16ms = ~60fps (1000ms / 60fps = 16.67ms)

  socket.on('token.move', (data: { tokenId: string; mapId: string; x: number; y: number }) => {
    handleTokenMove(socket, data);
  });

  /**
   * TOKEN.MOVE.END - User finishes dragging (final position)
   * Updates database and broadcasts to campaign
   */
  socket.on('token.move.end', async (data: { tokenId: string; mapId: string; x: number; y: number }) => {
    try {
      if (!socket.campaignId) {
        socket.emit('error', { message: 'Not authenticated to a campaign' });
        return;
      }

      // Flood ceiling: drop excess finalize writes silently. Shares the
      // per-socket budget with token.move; a normal drag stays far under it.
      if (!tokenMoveLimiter.check(socket.id, 150, 1000)) {
        return;
      }

      const { tokenId, mapId, x, y } = data;

      if (!tokenId || !mapId || typeof x !== 'number' || typeof y !== 'number') {
        socket.emit('error', { message: 'Invalid token move data' });
        return;
      }

      // Fetch the map
      const map = await prisma.map.findUnique({
        where: { id: mapId },
      });

      if (!map || map.campaignId !== socket.campaignId) {
        socket.emit('error', { message: 'Map not found' });
        return;
      }

      // Validate coordinates are within map bounds
      if (x < 0 || x >= map.width || y < 0 || y >= map.height) {
        socket.emit('error', { message: 'Token position out of bounds' });
        return;
      }

      // Get tokens array
      const tokensArray = (Array.isArray(map.tokens) ? map.tokens : []) as unknown as Token[];
      const tokenIndex = tokensArray.findIndex((t) => t.id === tokenId);

      if (tokenIndex === -1) {
        socket.emit('error', { message: 'Token not found' });
        return;
      }

      const token = tokensArray[tokenIndex];

      // Permission check: DM can move any token, players can only move their own
      if (socket.role !== 'DM' && token.controlledBy !== socket.userId) {
        socket.emit('error', { message: 'You do not have permission to move this token' });
        return;
      }

      // Spirit layer check: non-DMs cannot interact with spirit tokens when spirit layer is disabled
      if (token.layer === 'spirit' && socket.role !== 'DM') {
        const spiritVisible = await getSpiritVisibility(socket.campaignId, socket.userId!);
        if (!spiritVisible) {
          socket.emit('error', { message: 'You cannot interact with spirit layer tokens' });
          return;
        }
      }

      // Update token position
      const movedToken: Token = { ...token, position: { x, y } };

      // Update the tokens array in database
      const updatedTokens = [...tokensArray];
      updatedTokens[tokenIndex] = movedToken;

      await prisma.map.update({
        where: { id: mapId },
        data: { tokens: updatedTokens as any },
      });

      const movedPayload = { tokenId, mapId, x, y, movedBy: socket.userId };

      if (!map.lightingEnabled) {
        // Role-filtered: hidden tokens and spirit tokens only reach those who see them.
        await emitToTokenViewers(io, socket, map, updatedTokens, tokenId, 'token.moved', movedPayload, {
          excludeSender: false,
        });
      } else {
        // Dynamic lighting: each player's view before and after the move
        // (role filter, then line of sight). The moved token entering or
        // leaving sight is token:appeared / token:disappeared; if the move
        // shifted the player's own sight, every other token that entered or
        // left it is re-synced the same way. Only filtered tokens are sent.
        const view = tokenViewCache(map);
        for (const viewer of await getTokenViewers(io, socket.campaignId)) {
          if (viewer.isDM) {
            viewer.socket.emit('token.moved', movedPayload);
            continue;
          }
          const diff = diffTokenViews(view(tokensArray, viewer), view(updatedTokens, viewer), tokenId);
          if (diff.eventToken?.kind === 'removed') {
            viewer.socket.emit('token:disappeared', { tokenId, mapId });
          } else if (diff.eventToken) {
            viewer.socket.emit('token.moved', movedPayload);
            // Full token data in case this player didn't have it yet (frontend deduplicates).
            viewer.socket.emit('token:appeared', { token: diff.eventToken.token, mapId });
          }
          for (const t of diff.added) viewer.socket.emit('token:appeared', { token: t, mapId });
          for (const id of diff.removedIds) viewer.socket.emit('token:disappeared', { tokenId: id, mapId });
        }
      }

      logger.debug('token.move.end', { tokenId, x, y, userId: socket.userId });
    } catch (error) {
      logger.error('token.move.end failed', { err: error });
      socket.emit('error', { message: 'Failed to finalize token movement' });
    }
  });
}
