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
  getTokenViewersFor,
  tokenViewerKey,
  withLightPolygons,
  type TokenViewer,
  type TokenViewMap,
} from '../../utils/spirit-layer';
import logger from '../../utils/logger';
import { Token, tokenMoveLimiter } from '../shared';
import { bumpMapVersion, getMapVersion } from '../mapVersion';

/** A socket in the campaign room with the inputs of its token view. */
interface RoomViewer {
  socket: { id: string; emit: (event: string, payload: unknown) => unknown };
  viewer: TokenViewer;
}

/** The map fields a drag needs: bounds, campaign, tokens and the lighting inputs. */
const DRAG_MAP_SELECT = {
  campaignId: true,
  width: true,
  height: true,
  gridSize: true,
  tokens: true,
  lightingEnabled: true,
  wallSegments: true,
  lights: true,
} as const;

/** How long a drag reuses its map snapshot and viewers without a new read. */
export const DRAG_CONTEXT_TTL_MS = 500;

/** Every socket in the campaign room with its TokenViewer (role, plane, own characters). */
async function getRoomViewers(io: Server, campaignId: string): Promise<RoomViewer[]> {
  const campaignSockets = await io.in(campaignId).fetchSockets();
  return getTokenViewersFor(
    campaignId,
    campaignSockets.map((s) => s as unknown as AuthenticatedSocket)
  );
}

/**
 * A viewer's filtered view of a token array (filterTokensForViewer: role and
 * spirit plane, then line of sight on lighting maps), memoised per
 * (array, viewer) so a user's sockets share one computation.
 */
function tokenViewCache(map: TokenViewMap) {
  const cache = new Map<unknown[], Map<string, Token[]>>();
  return (tokens: Token[], viewer: TokenViewer): Token[] => {
    let byViewer = cache.get(tokens);
    if (!byViewer) cache.set(tokens, (byViewer = new Map()));
    const key = tokenViewerKey(viewer);
    let view = byViewer.get(key);
    if (!view) {
      view = filterTokensForViewer(tokens, map, viewer) as unknown as Token[];
      byViewer.set(key, view);
    }
    return view;
  };
}

/** Whether every campaign member sees this token without per-viewer filtering. */
function isPublicToken(map: TokenViewMap, token: Token | undefined): boolean {
  return !map.lightingEnabled && !!token && token.visible && token.layer === 'token';
}

/**
 * Emit a token-scoped event (`token.move.start`, `token.moved`) to the DMs
 * and to every other socket whose view of `tokens` contains the token — the
 * same per-recipient rules as map.changed (filterTokensForViewer).
 *
 * Shortcut: a visible material-plane token on a map without dynamic lighting
 * goes to every vetted socket in one emit, but only when every non-DM viewer
 * has a userId and sees the material plane (nobody is in the spirit realm,
 * where only spirit-layer tokens are visible) — then each of them would
 * receive it anyway. The emit targets the vetted socket ids, never the room:
 * viewers may be cached (DRAG_CONTEXT_TTL_MS), and a socket that joined since
 * was not vetted. Otherwise every viewer is checked.
 */
async function emitToTokenViewers(
  io: Server,
  sender: AuthenticatedSocket,
  map: TokenViewMap,
  tokens: Token[],
  tokenId: string,
  event: string,
  payload: unknown,
  { excludeSender, viewers }: { excludeSender: boolean; viewers: () => Promise<RoomViewer[]> }
): Promise<void> {
  const roomViewers = await viewers();
  const everyPlayerSeesMaterialPlane = roomViewers.every(
    ({ viewer }) => viewer.role === 'DM' || (!!viewer.userId && !viewer.spiritVisible)
  );
  if (everyPlayerSeesMaterialPlane && isPublicToken(map, tokens.find((t) => t.id === tokenId))) {
    const socketIds = roomViewers
      .map(({ socket }) => socket.id)
      .filter((id) => !(excludeSender && id === sender.id));
    // io.to([]) would broadcast to the whole namespace.
    if (socketIds.length > 0) io.to(socketIds).emit(event, payload);
    return;
  }

  const view = tokenViewCache(map);
  for (const { socket, viewer } of roomViewers) {
    if (excludeSender && socket.id === sender.id) continue;
    if (viewer.role === 'DM' || view(tokens, viewer).some((t) => t.id === tokenId)) {
      socket.emit(event, payload);
    }
  }
}

type FrameData = { tokenId: string; mapId: string; x: number; y: number };

/** What one drag reuses between frames: the map snapshot and the room's viewers. */
interface DragContext {
  mapId: string;
  /** getMapVersion(mapId) when loaded: a later map write invalidates the context. */
  version: number;
  map: TokenViewMap & { campaignId: string; tokens: unknown };
  viewers: () => Promise<RoomViewer[]>;
  expiresAt: number;
}

export function registerTokenHandlers(io: Server, socket: AuthenticatedSocket): void {
  // ── Per-socket drag state ────────────────────────────────────────────────
  // The map snapshot (bounds, tokens, walls, lights with their light polygons)
  // and the room's viewers are resolved once per drag and reused until
  // token.move.end, for at most DRAG_CONTEXT_TTL_MS, and only while the map's
  // in-process version (mapVersion.ts) is unchanged — any map writer bumps it,
  // so the next frame reloads.
  let drag: DragContext | null = null;
  // Frames are processed one at a time, in order; while one is processed only
  // the newest waiting frame is kept (stale frames are dropped, never queued).
  let frameInFlight: Promise<void> | null = null;
  let pendingFrame: FrameData | null = null;
  let lastFrame: FrameData | null = null;

  async function loadDragContext(mapId: string): Promise<DragContext | null> {
    if (drag && drag.mapId === mapId && drag.version === getMapVersion(mapId) && Date.now() < drag.expiresAt) {
      return drag;
    }
    const version = getMapVersion(mapId);
    const map = await prisma.map.findUnique({ where: { id: mapId }, select: DRAG_MAP_SELECT });
    if (!map || map.campaignId !== socket.campaignId) {
      drag = null;
      return null;
    }
    let viewers: Promise<RoomViewer[]> | null = null;
    const campaignId = socket.campaignId!;
    drag = {
      mapId,
      version,
      map: withLightPolygons(map),
      // Resolved once per drag context, on first use.
      viewers: () => (viewers ??= getRoomViewers(io, campaignId)),
      expiresAt: Date.now() + DRAG_CONTEXT_TTL_MS,
    };
    return drag;
  }

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

      // A new drag starts from a fresh map snapshot.
      drag = null;
      lastFrame = null;
      const ctx = await loadDragContext(mapId);

      if (!ctx) {
        socket.emit('error', { message: 'Map not found' });
        return;
      }

      // Get tokens array
      const tokensArray = (Array.isArray(ctx.map.tokens) ? ctx.map.tokens : []) as unknown as Token[];
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
        ctx.map,
        tokensArray,
        tokenId,
        'token.move.start',
        { tokenId, mapId, movedBy: socket.userId },
        { excludeSender: true, viewers: ctx.viewers }
      );

      logger.debug('token.move.start', { tokenId, userId: socket.userId, mapId });
    } catch (error) {
      logger.error('token.move.start failed', { err: error });
      socket.emit('error', { message: 'Failed to start token movement' });
    }
  });

  /**
   * One drag frame: validate, then send `token.moved` to the sockets that see
   * the token at its new cell. Runs from the per-socket frame queue only.
   */
  async function processFrame(data: FrameData): Promise<void> {
    try {
      if (!socket.campaignId) {
        return; // Silently ignore if not authenticated
      }

      const { tokenId, mapId, x, y } = data;

      if (!tokenId || !mapId || typeof x !== 'number' || typeof y !== 'number') {
        return; // Silently ignore invalid data during rapid updates
      }

      // Same token, same cell as this socket's last frame: nothing to send.
      if (
        lastFrame &&
        lastFrame.tokenId === tokenId &&
        lastFrame.mapId === mapId &&
        lastFrame.x === x &&
        lastFrame.y === y
      ) {
        return;
      }

      // Flood ceiling: drop excess frames silently — the 16ms throttle
      // already paces legitimate drags well under this limit.
      if (!tokenMoveLimiter.check(socket.id, 150, 1000)) {
        return;
      }

      // One map read per drag (or per DRAG_CONTEXT_TTL_MS), not per frame.
      const ctx = await loadDragContext(mapId);
      if (!ctx) {
        return; // Silently ignore invalid map during rapid updates
      }

      // Validate coordinates are within map bounds
      if (x < 0 || x >= ctx.map.width || y < 0 || y >= ctx.map.height) {
        socket.emit('error', { message: 'Token position out of bounds' });
        return;
      }

      // The frame's position decides who sees it (line of sight on lighting maps).
      const storedTokens = (Array.isArray(ctx.map.tokens) ? ctx.map.tokens : []) as unknown as Token[];
      const frameTokens = storedTokens.map((t) => (t.id === tokenId ? { ...t, position: { x, y } } : t));
      await emitToTokenViewers(
        io,
        socket,
        ctx.map,
        frameTokens,
        tokenId,
        'token.moved',
        { tokenId, mapId, x, y, movedBy: socket.userId },
        { excludeSender: true, viewers: ctx.viewers }
      );
      lastFrame = data;
    } catch (error) {
      logger.error('token.move failed', { err: error });
    }
  }

  /** Process queued frames one at a time, in arrival order (a stale waiting frame was overwritten). */
  async function drainFrames(): Promise<void> {
    try {
      while (pendingFrame) {
        const frame = pendingFrame;
        pendingFrame = null;
        await processFrame(frame);
      }
    } finally {
      frameInFlight = null;
    }
  }

  function enqueueFrame(data: FrameData): void {
    pendingFrame = data; // A frame still waiting is stale now: replace it.
    if (!frameInFlight) frameInFlight = drainFrames();
  }

  /**
   * TOKEN.MOVE - Position updates during drag (throttled to 60/s)
   * Validates coordinates and broadcasts to campaign
   */
  const handleTokenMove = throttle(enqueueFrame, 16); // 16ms = ~60fps (1000ms / 60fps = 16.67ms)

  socket.on('token.move', (data: FrameData) => {
    handleTokenMove(data);
  });

  /**
   * TOKEN.MOVE.END - User finishes dragging (final position)
   * Updates database and broadcasts to campaign
   */
  socket.on('token.move.end', async (data: FrameData) => {
    try {
      if (!socket.campaignId) {
        socket.emit('error', { message: 'Not authenticated to a campaign' });
        return;
      }

      // No drag frame may follow the final position: drop pending ones and
      // let the one being processed finish first.
      handleTokenMove.cancel();
      pendingFrame = null;
      if (frameInFlight) await frameInFlight;
      drag = null;
      lastFrame = null;

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
      bumpMapVersion(mapId); // other sockets' drag snapshots of this map are stale now

      const movedPayload = { tokenId, mapId, x, y, movedBy: socket.userId };
      const viewMap = withLightPolygons(map);
      let viewers: Promise<RoomViewer[]> | null = null;
      const roomViewers = () => (viewers ??= getRoomViewers(io, socket.campaignId!));

      if (!map.lightingEnabled) {
        // Role-filtered: hidden tokens and spirit tokens only reach those who see them.
        await emitToTokenViewers(io, socket, viewMap, updatedTokens, tokenId, 'token.moved', movedPayload, {
          excludeSender: false,
          viewers: roomViewers,
        });
      } else {
        // Dynamic lighting: each player's view before and after the move
        // (role filter, then line of sight). The moved token entering or
        // leaving sight is token:appeared / token:disappeared; if the move
        // shifted the player's own sight, every other token that entered or
        // left it is re-synced the same way. Only filtered tokens are sent.
        const view = tokenViewCache(viewMap);
        for (const { socket: s, viewer } of await roomViewers()) {
          if (viewer.role === 'DM') {
            s.emit('token.moved', movedPayload);
            continue;
          }
          const diff = diffTokenViews(view(tokensArray, viewer), view(updatedTokens, viewer), tokenId);
          if (diff.eventToken?.kind === 'removed') {
            s.emit('token:disappeared', { tokenId, mapId });
          } else if (diff.eventToken) {
            s.emit('token.moved', movedPayload);
            // Full token data in case this player didn't have it yet (frontend deduplicates).
            s.emit('token:appeared', { token: diff.eventToken.token, mapId });
          }
          for (const t of diff.added) s.emit('token:appeared', { token: t, mapId });
          for (const id of diff.removedIds) s.emit('token:disappeared', { tokenId: id, mapId });
        }
      }

      logger.debug('token.move.end', { tokenId, x, y, userId: socket.userId });
    } catch (error) {
      logger.error('token.move.end failed', { err: error });
      socket.emit('error', { message: 'Failed to finalize token movement' });
    }
  });
}
