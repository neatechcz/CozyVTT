// ============================================
// Character handler: character.hp.update
// Players update their own HP; DM can update any character's HP.
// ============================================

import { Server } from 'socket.io';
import { AuthenticatedSocket } from '../auth';
import { prisma } from '../../config/database';
import { withCharacterRowLock } from '../../services/characterLock';
import { resolveUpdatedBy } from '../../services/characterPatch';
import logger from '../../utils/logger';

type HpChange =
  | { error: string }
  | { current: number; max: number; temp: number; hpPath: string };

/**
 * System-aware HP read + apply delta. Mutates `charData` (a fresh copy read
 * under the row lock) and reports the path that changed.
 */
function applyHpDelta(gameSystem: string | null, charData: Record<string, any>, delta: number): HpChange {
  switch (gameSystem) {
    case 'DND_5E':
    case 'PATHFINDER_2E': {
      if (!charData.hp || typeof charData.hp.maximum !== 'number') {
        return { error: 'Character does not have HP tracking' };
      }
      const max = charData.hp.maximum;
      const temp = typeof charData.hp.temporary === 'number' ? charData.hp.temporary : 0;
      const current = Math.max(0, Math.min(max, (typeof charData.hp.current === 'number' ? charData.hp.current : max) + delta));
      charData.hp.current = current;
      return { current, max, temp, hpPath: 'hp.current' };
    }
    case 'CALL_OF_CTHULHU_7E': {
      if (!charData.derivedStats?.hp || typeof charData.derivedStats.hp.maximum !== 'number') {
        return { error: 'Character does not have HP tracking' };
      }
      const max = charData.derivedStats.hp.maximum;
      const current = Math.max(0, Math.min(max, (typeof charData.derivedStats.hp.current === 'number' ? charData.derivedStats.hp.current : max) + delta));
      charData.derivedStats.hp.current = current;
      return { current, max, temp: 0, hpPath: 'derivedStats.hp.current' };
    }
    default:
      return { error: 'HP tracking not supported for this game system' };
  }
}

export function registerCharacterHandlers(io: Server, socket: AuthenticatedSocket): void {
  socket.on('character.hp.update', async (data: { characterId: string; delta: number }) => {
    try {
      if (!socket.campaignId) {
        socket.emit('error', { message: 'Not authenticated to a campaign' });
        return;
      }
      const campaignId = socket.campaignId;

      const { characterId, delta } = data;

      if (!characterId || typeof delta !== 'number' || !Number.isFinite(delta)) {
        socket.emit('error', { message: 'characterId (string) and delta (number) are required' });
        return;
      }

      // Read → modify → write under the character row lock, serialised with
      // PUT / PATCH, so a change committed meanwhile is never reverted.
      const outcome = await withCharacterRowLock(prisma, characterId, async (tx) => {
        const character = await tx.character.findUnique({
          where: { id: characterId },
        });

        if (!character) {
          return { error: 'Character not found' };
        }

        // Verify character belongs to this campaign (the full sheet is broadcast)
        if (character.campaignId !== campaignId) {
          return { error: 'Character is not in this campaign' };
        }

        const membership = await tx.campaignMembership.findFirst({
          where: { campaignId, characterIds: { has: characterId } },
        });

        if (!membership) {
          return { error: 'Character is not in this campaign' };
        }

        // Permission: character owner or DM
        if (character.userId !== socket.userId && socket.role !== 'DM') {
          return { error: 'You do not have permission to update this character\'s HP' };
        }

        const charData = character.data as Record<string, any>;
        const change = applyHpDelta(character.gameSystem, charData, delta);
        if ('error' in change) {
          return change;
        }

        // Save updated character data
        const saved = await tx.character.update({
          where: { id: characterId },
          data: { data: charData },
          include: {
            campaign: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });

        return { ...change, saved };
      });

      if ('error' in outcome) {
        socket.emit('error', { message: outcome.error });
        return;
      }

      // Committed — broadcast updated HP to all campaign members
      const { current, max, temp, hpPath, saved } = outcome;
      io.to(campaignId).emit('character.hp.updated', {
        characterId,
        hp: { current, max, temp },
      });

      // Same event as PUT/PATCH so open sheet editors merge the HP change
      try {
        const updatedBy = await resolveUpdatedBy(prisma, socket.userId!);
        io.to(campaignId).emit('character.updated', {
          characterId,
          character: saved,
          userId: socket.userId,
          changedPaths: [hpPath],
          updatedBy,
        });
      } catch (error) {
        logger.error('Failed to broadcast character update', { err: error });
      }

    } catch (error) {
      logger.error('character.hp.update failed', { err: error });
      socket.emit('error', { message: 'Failed to update character HP' });
    }
  });
}
