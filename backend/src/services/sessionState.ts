/**
 * Session State Management Service
 * Session State Management
 *
 * Handles capture and restoration of campaign game state including:
 * - Token positions
 * - Current map
 * - Vibe tracker settings
 * - Spirit layer visibility
 * - Map annotations
 */

import { prisma } from '../config/database';
import { lockCampaignMapRows, MapRowNotFoundError, withCampaignRowLock } from './combatStatePersistence';
import { readCombatState } from '../websocket/initiativeState';
import logger from '../utils/logger';
import { bumpMapVersion } from '../websocket/mapVersion';

export class ActiveCombatRestoreError extends Error {
  constructor() {
    super('Cannot restore a saved session during active combat');
    this.name = 'ActiveCombatRestoreError';
  }
}

/**
 * Game State Interface
 * Saved State JSON Structure
 */
export interface GameState {
  sessionId?: string;
  savedAt: string;
  mapId: string | null;
  tokens: any[];
  spiritLayerVisible: boolean;
  currentVibe: string | null;
  annotations: any[];
}

/**
 * Capture the current game state for a campaign
 * State Persistence
 *
 * @param campaignId - Campaign ID
 * @param sessionId - Optional session ID to include in state
 * @returns GameState object
 */
export async function captureGameState(
  campaignId: string,
  sessionId?: string
): Promise<GameState> {
  try {
    // Get campaign with current map
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        currentMap: {
          select: {
            id: true,
            tokens: true,
            annotations: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new Error('Campaign not found');
    }

    // Build state object
    const state: GameState = {
      sessionId: sessionId || undefined,
      savedAt: new Date().toISOString(),
      mapId: campaign.currentMapId,
      tokens: campaign.currentMap?.tokens ? (Array.isArray(campaign.currentMap.tokens) ? campaign.currentMap.tokens : []) : [],
      spiritLayerVisible: campaign.spiritLayerEnabled,
      currentVibe: campaign.currentVibe,
      annotations: campaign.currentMap?.annotations ? (Array.isArray(campaign.currentMap.annotations) ? campaign.currentMap.annotations : []) : [],
    };

    logger.info(`📸 Captured game state for campaign ${campaignId}`);
    return state;
  } catch (error) {
    logger.error('❌ Error capturing game state', { err: error });
    throw error;
  }
}

/**
 * Restore saved game state to a campaign
 * Resuming a Session
 *
 * @param campaignId - Campaign ID
 * @param state - GameState object to restore
 */
export async function restoreGameState(
  campaignId: string,
  state: GameState
): Promise<void> {
  try {
    let mapRestored = false;
    await withCampaignRowLock(prisma, campaignId, async (tx, campaign) => {
      if (readCombatState(campaign.combatState).active) {
        throw new ActiveCombatRestoreError();
      }

      await tx.campaign.update({
        where: { id: campaignId },
        data: {
          currentMapId: state.mapId,
          spiritLayerEnabled: state.spiritLayerVisible,
          currentVibe: state.currentVibe,
        },
      });

      if (!state.mapId) return;
      try {
        const { map } = await lockCampaignMapRows(tx, campaignId, state.mapId);
        await tx.map.update({
          where: { id: map.id },
          data: {
            tokens: state.tokens as any,
            annotations: state.annotations as any,
          },
        });
        mapRestored = true;
      } catch (error) {
        if (!(error instanceof MapRowNotFoundError)) throw error;
      }
    });

    if (state.mapId && mapRestored) {
      bumpMapVersion(state.mapId); // cached drag snapshots of this map are stale now
      logger.info(`✅ Restored game state for campaign ${campaignId} (map: ${state.mapId})`);
    } else if (state.mapId) {
      logger.warn(`⚠️ Map ${state.mapId} not found or doesn't belong to campaign ${campaignId}`);
    }

    logger.info(`✅ Restored game state for campaign ${campaignId}`);
  } catch (error) {
    logger.error('❌ Error restoring game state', { err: error });
    throw error;
  }
}

/**
 * Get the most recent session for a campaign
 * Useful for resuming the last session
 *
 * @param campaignId - Campaign ID
 * @returns Session record or null
 */
export async function getLastSession(campaignId: string) {
  return await prisma.session.findFirst({
    where: { campaignId },
    orderBy: { startedAt: 'desc' },
  });
}

/**
 * Get the next session number for a campaign
 * Auto-increments based on existing sessions
 *
 * @param campaignId - Campaign ID
 * @returns Next session number
 */
export async function getNextSessionNumber(campaignId: string): Promise<number> {
  const lastSession = await prisma.session.findFirst({
    where: { campaignId },
    orderBy: { sessionNumber: 'desc' },
    select: { sessionNumber: true },
  });

  return (lastSession?.sessionNumber || 0) + 1;
}
