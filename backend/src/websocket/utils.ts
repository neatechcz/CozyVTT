import { Server } from 'socket.io';
import { prisma } from '../config/database';
import logger from '../utils/logger';
import {
  diffTokenViews,
  filterTokensForViewer,
  getTokenViewersFor,
  tokenViewerKey,
  withLightPolygons,
  type TokenViewMap,
} from '../utils/spirit-layer';
import type { AuthenticatedSocket } from './auth';
import { bumpMapVersion } from './mapVersion';

/**
 * WebSocket Utility Functions
 * WebSocket Event Specification
 */

let ioInstance: Server | null = null;

/**
 * Store the Socket.io instance for use in utility functions
 */
export function setSocketInstance(io: Server): void {
  ioInstance = io;
}

/**
 * Get the Socket.io instance
 */
export function getSocketInstance(): Server {
  if (!ioInstance) {
    throw new Error('Socket.io instance not initialized');
  }
  return ioInstance;
}

/**
 * Broadcast an event to all members of a campaign
 * @param campaignId - Campaign ID
 * @param event - Event name
 * @param data - Event data
 */
export function broadcastToCampaign(campaignId: string, event: string, data: any): void {
  const io = getSocketInstance();
  io.to(campaignId).emit(event, data);
}

/**
 * Broadcast an event to a specific user (all their connected sockets)
 * @param userId - User ID
 * @param event - Event name
 * @param data - Event data
 */
export function broadcastToUser(userId: string, event: string, data: any): void {
  const io = getSocketInstance();
  io.to(userId).emit(event, data);
}

/**
 * Users who may see a campaign character's full sheet: its owner, every DM
 * of the campaign and every PLAYER the character is assigned to. Sheet data
 * (the whole character, its HP) goes only to these users' personal rooms,
 * never to the campaign room — other players and spectators must not see it.
 */
export async function getCharacterSheetRecipientIds(
  campaignId: string,
  characterId: string,
  ownerId: string
): Promise<string[]> {
  const memberships = await prisma.campaignMembership.findMany({
    where: {
      campaignId,
      OR: [
        { role: 'DM' },
        { role: 'PLAYER', characterIds: { has: characterId } },
      ],
    },
    select: { userId: true },
  });
  return [...new Set([ownerId, ...memberships.map((m) => m.userId)])];
}

/**
 * Emit a sheet event (`character.updated`, …) to everyone who may see the
 * character's full sheet (getCharacterSheetRecipientIds). A character outside
 * any campaign broadcasts nothing. One emit to all recipient rooms, so a
 * socket in several of them receives it once.
 */
export async function broadcastToCharacterViewers(
  character: { id: string; campaignId: string | null; userId: string },
  event: string,
  data: unknown,
  io: Pick<Server, 'to'> = getSocketInstance()
): Promise<void> {
  if (!character.campaignId) return;
  const recipients = await getCharacterSheetRecipientIds(character.campaignId, character.id, character.userId);
  io.to(recipients).emit(event, data);
}

/** A token as stored in a map's `tokens` JSON array (only `id` is read directly). */
type StoredToken = { id: string };

/** The stored map fields a token event needs to compute players' lighting views. */
const TOKEN_VIEW_MAP_SELECT = {
  tokens: true,
  lightingEnabled: true,
  wallSegments: true,
  lights: true,
  width: true,
  height: true,
  gridSize: true,
} as const;

type TokenEvent = [event: string, payload: unknown];

/**
 * The map's token array with the event's token set to `token` (replaced in
 * place, appended when absent, dropped when `token` is null). The rest of the
 * array is the map as stored now.
 */
function withEventToken(tokens: unknown, tokenId: string, token: StoredToken | null): StoredToken[] {
  const stored = (Array.isArray(tokens) ? tokens : []) as StoredToken[];
  const others = stored.filter((t) => t?.id !== tokenId);
  if (!token) return others;
  const index = stored.findIndex((t) => t?.id === tokenId);
  if (index === -1) return [...others, token];
  const next = [...stored];
  next[index] = token;
  return next;
}

/** The non-DM sockets of a campaign room with their TokenViewer inputs, plus the DM sockets. */
async function getCampaignViewers(campaignId: string) {
  const io = getSocketInstance();
  const campaignSockets = await io.in(campaignId).fetchSockets();
  const authed = campaignSockets.map((s) => s as unknown as AuthenticatedSocket & { emit: typeof s.emit });
  return getTokenViewersFor(campaignId, authed);
}

/**
 * Broadcast a token add / update / remove made through the REST routes.
 *
 * Pass the token as it was before the write (`null` when it was just
 * created) and as it is after the write (`null` when it was deleted). Each
 * socket in the campaign room receives the events that turn its view of the
 * map from "before" into "after", using the same per-viewer pipeline as
 * map.changed (filterTokensForViewer: filterTokensByRole, then line of sight):
 * - DM sockets see every token: `token.added` / `token.updated` / `token.removed`.
 * - Other sockets only see tokens that pass filterTokensByRole (visible, on
 *   the plane they currently see, DM-only `notes` stripped). A token that
 *   becomes hidden from them arrives as `token.removed`; one that becomes
 *   visible arrives as `token.added`; a token they never see sends nothing.
 *   A non-DM socket without a userId receives nothing.
 * - On a map with dynamic lighting, a player additionally sees only tokens
 *   in their line of sight (filterTokensByLighting; own tokens per
 *   isOwnToken). Their whole before/after view is compared, so the event's
 *   token entering / leaving sight is `token.added` / `token.removed`, and a
 *   change that moves their sight (their own token moved, assigned, hidden or
 *   removed) also sends `token.added` / `token.removed` for every other token
 *   that entered or left it. The event's own token is always emitted first.
 *
 * Views are computed from the map as stored when the broadcast runs, with
 * the event's token set to `before` / `after`. If the map can no longer be
 * read, players receive nothing (fail closed); DMs still do.
 *
 * Payloads: `token.added|token.updated { mapId, token }`,
 * `token.removed { mapId, tokenId }`.
 *
 * Never throws — a failed broadcast is logged and must not fail the REST
 * request whose database write already succeeded.
 */
export async function broadcastTokenEvent(
  campaignId: string,
  mapId: string,
  before: StoredToken | null,
  after: StoredToken | null
): Promise<void> {
  try {
    const tokenId = after?.id ?? before?.id;
    if (!tokenId) return;
    bumpMapVersion(mapId); // cached drag snapshots of this map are stale now

    const viewers = await getCampaignViewers(campaignId);
    const hasPlayers = viewers.some(({ viewer }) => viewer.role !== 'DM');
    const storedMap = hasPlayers
      ? await prisma.map.findUnique({ where: { id: mapId }, select: TOKEN_VIEW_MAP_SELECT })
      : null;
    const map = storedMap ? withLightPolygons(storedMap) : null;

    // Without lighting a token's visibility does not depend on the others: filter just it.
    const beforeTokens = map?.lightingEnabled ? withEventToken(map.tokens, tokenId, before) : before ? [before] : [];
    const afterTokens = map?.lightingEnabled ? withEventToken(map.tokens, tokenId, after) : after ? [after] : [];
    const eventsByViewer = new Map<string, TokenEvent[]>();

    for (const { socket, viewer } of viewers) {
      if (viewer.role === 'DM') {
        if (after) {
          socket.emit(before ? 'token.updated' : 'token.added', { mapId, token: after });
        } else if (before) {
          socket.emit('token.removed', { mapId, tokenId });
        }
        continue;
      }
      if (!map) continue; // Map gone: its lighting is unknown, so send nothing (fail closed).

      const key = tokenViewerKey(viewer);
      let events = eventsByViewer.get(key);
      if (!events) {
        const diff = diffTokenViews(
          filterTokensForViewer(beforeTokens, map, viewer),
          filterTokensForViewer(afterTokens, map, viewer),
          tokenId
        );
        events = [];
        if (diff.eventToken?.kind === 'removed') {
          events.push(['token.removed', { mapId, tokenId }]);
        } else if (diff.eventToken) {
          events.push([`token.${diff.eventToken.kind}`, { mapId, token: diff.eventToken.token }]);
        }
        for (const t of diff.added) events.push(['token.added', { mapId, token: t }]);
        for (const id of diff.removedIds) events.push(['token.removed', { mapId, tokenId: id }]);
        eventsByViewer.set(key, events);
      }
      for (const [event, payload] of events) socket.emit(event, payload);
    }
  } catch (error) {
    logger.error('Token broadcast failed', { err: error, campaignId, mapId });
  }
}

/**
 * The map fields whose change can move what players see on a lighting map.
 * Pass their values from before the write to broadcastMapViewChange.
 */
export type MapViewFields = Partial<
  Pick<TokenViewMap, 'lightingEnabled' | 'wallSegments' | 'lights' | 'width' | 'height' | 'gridSize'>
>;

/**
 * After a write that changes what players can see without touching tokens —
 * a wall or door, a light, the lighting toggle, the map's size or grid —
 * send each player the tokens that entered or left their view.
 *
 * `previous` holds the changed fields' values from before the write; the
 * rest of the map (tokens, other fields) is read as stored now. Each player's
 * view with the previous and with the current fields goes through
 * filterTokensForViewer and diffTokenViews; the result is `token.added
 * { mapId, token }` / `token.removed { mapId, tokenId }`. DMs see every token
 * and receive nothing. Skips the map read when no player is connected, and
 * the diff when lighting is off both before and after.
 *
 * Never throws — a failed broadcast is logged.
 */
export async function broadcastMapViewChange(
  campaignId: string,
  mapId: string,
  previous: MapViewFields
): Promise<void> {
  try {
    bumpMapVersion(mapId); // cached drag snapshots of this map are stale now
    const viewers = (await getCampaignViewers(campaignId)).filter(({ viewer }) => viewer.role !== 'DM');
    if (viewers.length === 0) return;

    const stored = await prisma.map.findUnique({ where: { id: mapId }, select: TOKEN_VIEW_MAP_SELECT });
    if (!stored) return;
    const beforeMap = { ...stored, ...previous };
    if (!stored.lightingEnabled && !beforeMap.lightingEnabled) return;

    const mapBefore = withLightPolygons(beforeMap);
    const mapAfter = withLightPolygons(stored);
    const eventsByViewer = new Map<string, TokenEvent[]>();

    for (const { socket, viewer } of viewers) {
      const key = tokenViewerKey(viewer);
      let events = eventsByViewer.get(key);
      if (!events) {
        const diff = diffTokenViews(
          filterTokensForViewer(stored.tokens, mapBefore, viewer),
          filterTokensForViewer(stored.tokens, mapAfter, viewer),
          null
        );
        events = [
          ...diff.added.map((token): TokenEvent => ['token.added', { mapId, token }]),
          ...diff.removedIds.map((tokenId): TokenEvent => ['token.removed', { mapId, tokenId }]),
        ];
        eventsByViewer.set(key, events);
      }
      for (const [event, payload] of events) socket.emit(event, payload);
    }
  } catch (error) {
    logger.error('Map view-change broadcast failed', { err: error, campaignId, mapId });
  }
}

/**
 * Get all sockets in a campaign room
 * @param campaignId - Campaign ID
 * @returns Array of socket IDs
 */
export async function getSocketsInCampaign(campaignId: string): Promise<string[]> {
  const io = getSocketInstance();
  const sockets = await io.in(campaignId).fetchSockets();
  return sockets.map((socket) => socket.id);
}

/**
 * Get campaign member count (connected users)
 * @param campaignId - Campaign ID
 * @returns Number of connected users
 */
export async function getCampaignMemberCount(campaignId: string): Promise<number> {
  const io = getSocketInstance();
  const sockets = await io.in(campaignId).fetchSockets();
  return sockets.length;
}

/**
 * Disconnect a user's sockets (for forced logout, bans, etc.)
 * @param userId - User ID
 * @param reason - Reason for disconnection
 */
export async function disconnectUser(userId: string, reason: string): Promise<void> {
  const io = getSocketInstance();
  const sockets = await io.in(userId).fetchSockets();

  sockets.forEach((socket) => {
    socket.emit('error', { message: reason });
    socket.disconnect(true);
  });

  logger.info(`❌ Disconnected user ${userId}: ${reason}`);
}

/**
 * Send a system message to a campaign
 * Creates a database record and broadcasts to all campaign members
 * System Messages
 *
 * @param campaignId - Campaign ID
 * @param content - Message content
 * @param metadata - Optional metadata (e.g., { userId, action })
 */
export async function sendSystemMessage(
  campaignId: string,
  content: string,
  metadata?: Record<string, any>
): Promise<void> {
  try {
    // Save to database
    const message = await prisma.message.create({
      data: {
        campaignId,
        userId: null, // System messages have no user
        type: 'SYSTEM',
        content,
        metadata: metadata ? (metadata as any) : null,
      },
    });

    // Broadcast to campaign
    const io = getSocketInstance();
    io.to(campaignId).emit('chat.system', {
      id: message.id,
      content,
      metadata: metadata || null,
      timestamp: message.createdAt.toISOString(),
    });

    logger.info(`📢 System message to campaign ${campaignId}: ${content}`);
  } catch (error) {
    // Log but never re-throw — a failed system message must not crash the server
    // (e.g. when the campaign was deleted just before the disconnect fires).
    logger.error('❌ Error sending system message', { err: error });
  }
}
