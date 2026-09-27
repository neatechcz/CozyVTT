import { Server } from 'socket.io';
import { AuthenticatedSocket, authenticateSocket, authenticateCampaign } from './auth';
import { broadcastPresence, getOnlineUserIds } from './utils';
import logger from '../utils/logger';
import { registerTokenHandlers } from './handlers/tokens';
import { registerDiceHandlers } from './handlers/dice';
import { registerChatHandlers } from './handlers/chat';
import { registerSpiritHandlers } from './handlers/spirit';
import { registerVibeHandlers } from './handlers/vibe';
import { registerMapHandlers } from './handlers/maps';
import { registerAtmosphereHandlers } from './handlers/atmosphere';
import { registerCharacterHandlers } from './handlers/characters';
import { registerInitiativeHandlers } from './handlers/initiative';
import { registerWallHandlers } from './handlers/walls';
import { registerFogHandlers } from './handlers/fog';
import { registerLightHandlers } from './handlers/lights';
import { registerPingHandlers } from './handlers/pings';

/**
 * WebSocket Event Handlers — orchestrator.
 *
 * Per-domain handlers live under ./handlers/*. This file owns only the
 * connection lifecycle (connect → authenticateSocket → authenticate/
 * disconnect/ping/error) and wires each domain's
 * `registerXxxHandlers(io, socket)` per connection. Shared state (rate
 * limiters, fog helpers, the Token shape) lives in ./shared.
 */

/**
 * Register all WebSocket event handlers
 * @param io - Socket.io server instance
 */
export function registerEventHandlers(io: Server): void {
  io.on('connection', async (socket: AuthenticatedSocket) => {
    logger.debug('ws connection attempt', { socketId: socket.id });

    // CRITICAL: Authenticate the socket connection
    const authenticated = await authenticateSocket(socket);

    if (!authenticated) {
      logger.warn('ws unauthenticated connection rejected', { socketId: socket.id });
      socket.emit('error', { message: 'Unauthorized' });
      socket.disconnect(true);
      return;
    }

    // Add socket to user's personal room (for direct messaging)
    if (socket.userId) {
      socket.join(socket.userId);
      logger.debug('ws joined user room', { socketId: socket.id, userId: socket.userId });
    }

    // Send connection acknowledgment
    socket.emit('connected', {
      userId: socket.userId,
      timestamp: new Date().toISOString(),
    });

    // ============================================
    // AUTHENTICATE EVENT
    // User requests to join a campaign room
    // ============================================
    socket.on('authenticate', async (data: { campaignId: string; quiet?: boolean }) => {
      try {
        logger.debug('authenticate', { campaignId: data.campaignId, userId: socket.userId, quiet: data.quiet });

        if (!data.campaignId || typeof data.campaignId !== 'string') {
          socket.emit('error', { message: 'Campaign ID required' });
          return;
        }

        // Authenticate campaign membership
        const result = await authenticateCampaign(socket, data.campaignId);

        if (!result.success) {
          socket.emit('error', { message: result.error });
          return;
        }

        // SECURITY: Enforce single campaign context per socket. Everything
        // below runs synchronously (no await) so the room, campaignId and role
        // always change together — per-recipient filters that read
        // socket.role can never see one campaign's room with another's role.
        const previousCampaignId = socket.campaignId;
        const previousQuiet = socket.quiet === true;
        const quiet = data.quiet === true;

        // Leave every other campaign room (keep the socket's own and the
        // user's personal room): exactly one campaign room per socket
        for (const room of [...socket.rooms]) {
          if (room !== socket.id && room !== socket.userId && room !== data.campaignId) {
            void socket.leave(room);
          }
        }

        // Join the campaign room — quiet sockets too, so they receive every
        // campaign event; only the announcements are skipped for them
        socket.join(data.campaignId);
        socket.campaignId = data.campaignId;
        socket.role = result.role;
        // Re-authenticating to the campaign it was already announced in stays
        // announced, so its leave is announced too
        socket.quiet = previousCampaignId === data.campaignId ? previousQuiet && quiet : quiet;

        // Notify old campaign that user left (a quiet join was never announced)
        if (previousCampaignId && previousCampaignId !== data.campaignId) {
          if (!previousQuiet) {
            socket.to(previousCampaignId).emit('user.left', {
              userId: socket.userId,
              timestamp: new Date().toISOString(),
            });
          }
          // Presence includes quiet editor sockets; recompute after the room
          // switch so a second tab keeps the user online in the old campaign.
          await broadcastPresence(previousCampaignId);
        }

        // Notify the user they've been authenticated
        socket.emit('authenticated', {
          userId: socket.userId,
          campaignId: data.campaignId,
          role: result.role,
          timestamp: new Date().toISOString(),
        });

        if (!quiet) {
          socket.to(data.campaignId).emit('user.joined', {
            userId: socket.userId,
            timestamp: new Date().toISOString(),
          });
        }

        await broadcastPresence(data.campaignId);

        logger.info('authenticated', { userId: socket.userId, campaignId: data.campaignId, role: result.role, quiet });
      } catch (error) {
        logger.error('authenticate failed', { err: error });
        socket.emit('error', { message: 'Authentication failed' });
      }
    });

    // ============================================
    // PRESENCE REQUEST
    // A client asking who is online right now.
    // ============================================
    // Presence is pushed on every join and leave, but a component that mounts
    // after this socket authenticated would have missed its own snapshot and
    // would then show everyone offline until somebody else moved. This lets it
    // ask. Replies to the caller alone — nobody else's view has changed.
    socket.on('presence.request', async () => {
      if (!socket.campaignId) return;
      try {
        const onlineUserIds = await getOnlineUserIds(socket.campaignId);
        socket.emit('presence.state', { campaignId: socket.campaignId, onlineUserIds });
      } catch (error) {
        logger.error('presence.request failed', { err: error });
      }
    });

    // ============================================
    // DOMAIN HANDLERS — one registrar per domain
    // ============================================
    registerTokenHandlers(io, socket);
    registerDiceHandlers(io, socket);
    registerChatHandlers(io, socket);
    registerSpiritHandlers(io, socket);
    registerVibeHandlers(io, socket);
    registerMapHandlers(io, socket);
    registerAtmosphereHandlers(io, socket);
    registerCharacterHandlers(io, socket);
    registerInitiativeHandlers(io, socket);
    registerWallHandlers(io, socket);
    registerFogHandlers(io, socket);
    registerLightHandlers(io, socket);
    registerPingHandlers(io, socket);

    // ============================================
    // DISCONNECT EVENT
    // Clean up when user disconnects
    // ============================================
    socket.on('disconnect', async (reason: string) => {
      logger.debug('ws disconnected', { socketId: socket.id, reason });

      // Notify campaign members if user was in a campaign (not for a quiet join)
      if (socket.campaignId) {
        if (!socket.quiet) {
          socket.to(socket.campaignId).emit('user.left', {
            userId: socket.userId,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Leave all rooms
      socket.rooms.forEach((room) => {
        if (room !== socket.id) {
          socket.leave(room);
        }
      });
      // Recompute after leaving: another tab for this user may remain online.
      if (socket.campaignId) await broadcastPresence(socket.campaignId);
    });

    // ============================================
    // PING/PONG HEARTBEAT
    // Connection health monitoring
    // ============================================
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: new Date().toISOString() });
    });

    // ============================================
    // ERROR HANDLER
    // Catch unhandled socket errors
    // ============================================
    socket.on('error', (error: Error) => {
      logger.error('socket error', { err: error });
    });
  });
}
