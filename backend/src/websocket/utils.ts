import { Server } from 'socket.io';
import { prisma } from '../config/database';
import logger from '../utils/logger';
import { filterTokensByRole, getSpiritVisibilityBatch } from '../utils/spirit-layer';
import type { AuthenticatedSocket } from './auth';

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

/**
 * Broadcast a token add / update / remove made through the REST routes.
 *
 * Pass the token as it was before the write (`null` when it was just
 * created) and as it is after the write (`null` when it was deleted). Each
 * socket in the campaign room receives the event that turns its view of the
 * token from "before" into "after", using the same rules as the map GET
 * (filterTokensByRole):
 * - DM sockets see every token: `token.added` / `token.updated` / `token.removed`.
 * - Other sockets only see tokens that pass filterTokensByRole (visible, on
 *   the plane they currently see, DM-only `notes` stripped). A token that
 *   becomes hidden from them arrives as `token.removed`; one that becomes
 *   visible arrives as `token.added`; a token they never see sends nothing.
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

    const io = getSocketInstance();
    const campaignSockets = await io.in(campaignId).fetchSockets();
    const authedSockets = campaignSockets.map((s) => s as unknown as AuthenticatedSocket);

    const needsSpiritVisibility = authedSockets.some((s) => s.role !== 'DM' && s.userId);
    const visibility = needsSpiritVisibility
      ? await getSpiritVisibilityBatch(
          campaignId,
          authedSockets.map((s) => s.userId).filter((id): id is string => !!id)
        )
      : new Map<string, boolean>();

    for (const s of campaignSockets) {
      const authedSocket = s as unknown as AuthenticatedSocket;
      let seenBefore: unknown = before;
      let seenAfter: unknown = after;

      if (authedSocket.role !== 'DM') {
        const role = authedSocket.role ?? 'SPECTATOR';
        const spiritVisible = !!(authedSocket.userId && visibility.get(authedSocket.userId));
        seenBefore = before ? filterTokensByRole([before], role, spiritVisible)[0] ?? null : null;
        seenAfter = after ? filterTokensByRole([after], role, spiritVisible)[0] ?? null : null;
      }

      if (seenAfter) {
        s.emit(seenBefore ? 'token.updated' : 'token.added', { mapId, token: seenAfter });
      } else if (seenBefore) {
        s.emit('token.removed', { mapId, tokenId });
      }
    }
  } catch (error) {
    logger.error('Token broadcast failed', { err: error, campaignId, mapId });
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
