// ============================================
// Character handlers: character.hp.update, character.hitdice.spend
// Players act on their own characters; the DM may act on any of them.
// ============================================

import { Server } from 'socket.io';
import { AuthenticatedSocket } from '../auth';
import { prisma } from '../../config/database';
import { withCharacterRowLock, isCharacterLockTimeout, CHARACTER_BUSY_MESSAGE } from '../../services/characterLock';
import { resolveUpdatedBy } from '../../services/characterPatch';
import { getCharacterSheetRecipientIds } from '../utils';
import logger from '../../utils/logger';
import { toJson } from '../../utils/prisma-json';
import { effectiveDnd5eHpMaximum } from '../../utils/dnd5eExhaustion';

/** One hit dice pool: `total` is the pool ("5d8"), `remaining` how many are left. */
interface HitDiceEntry {
  class?: unknown;
  total?: unknown;
  remaining?: unknown;
}
interface CharacterHitDiceData {
  hitDice?: unknown;
  [key: string]: unknown;
}
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
      const max = gameSystem === 'DND_5E'
        ? effectiveDnd5eHpMaximum(charData) ?? charData.hp.maximum
        : charData.hp.maximum;
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

        // Resolve the caller's current membership (read under the lock):
        // assignment may have changed since the socket first authenticated.
        const membership = await tx.campaignMembership.findUnique({
          where: { userId_campaignId: { userId: socket.userId!, campaignId } },
        });

        // Verify character belongs to this campaign (the full sheet is broadcast)
        if (!membership || character.campaignId !== campaignId) {
          return { error: 'Character is not in this campaign' };
        }

        // Permission: owner, DM, or the PLAYER explicitly assigned this character.
        if (character.userId !== socket.userId && membership.role !== 'DM' &&
          !(membership.role === 'PLAYER' && membership.characterIds.includes(characterId))) {
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

      // Committed. HP and the full sheet are sheet data: send them only to the
      // owner, the campaign DMs and the assigned player — never the campaign room.
      const { current, max, temp, hpPath, saved } = outcome;
      try {
        const recipients = await getCharacterSheetRecipientIds(campaignId, characterId, saved.userId);
        io.to(recipients).emit('character.hp.updated', {
          characterId,
          hp: { current, max, temp },
        });

        // Same event as PUT/PATCH so open sheet editors merge the HP change
        const updatedBy = await resolveUpdatedBy(prisma, socket.userId!);
        io.to(recipients).emit('character.updated', {
          characterId,
          character: saved,
          userId: socket.userId,
          changedPaths: [hpPath],
          updatedBy,
        });
      } catch (error) {
        logger.error('Failed to broadcast character HP update', { err: error });
      }

    } catch (error) {
      if (isCharacterLockTimeout(error)) {
        // The row lock was not obtained in time (another writer holds it)
        socket.emit('error', { message: CHARACTER_BUSY_MESSAGE });
        return;
      }
      logger.error('character.hp.update failed', { err: error });
      socket.emit('error', { message: 'Failed to update character HP' });
    }
  });

  /**
   * CHARACTER.HITDICE.SPEND — spend one D&D 5e hit die.
   *
   * The roll itself goes through `dice.roll` like every other roll; this only
   * decrements the pool, so the count cannot be inflated by a client that
   * simply declines to send it. Same permission rule as HP: the character's
   * owner, or the DM covering for an absent player.
   */
  socket.on('character.hitdice.spend', async (data: { characterId: string; index: number }) => {
    try {
      if (!socket.campaignId) {
        socket.emit('error', { message: 'Not authenticated to a campaign' });
        return;
      }

      const { characterId, index } = data ?? {};

      if (!characterId || typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        socket.emit('error', { message: 'characterId (string) and index (integer) are required' });
        return;
      }

      const campaignId = socket.campaignId;
      const outcome = await withCharacterRowLock(prisma, characterId, async (tx) => {
        const character = await tx.character.findUnique({ where: { id: characterId } });
        if (!character) return { error: 'Character not found' };

        const membership = await tx.campaignMembership.findUnique({
          where: { userId_campaignId: { userId: socket.userId!, campaignId } },
        });
        if (!membership || character.campaignId !== campaignId) {
          return { error: 'Character is not in this campaign' };
        }
        if (character.userId !== socket.userId && membership.role !== 'DM' &&
          !(membership.role === 'PLAYER' && membership.characterIds.includes(characterId))) {
          return { error: 'You do not have permission to spend this character\'s hit dice' };
        }
        if (character.gameSystem !== 'DND_5E') {
          return { error: 'Hit dice are not tracked for this game system' };
        }

        const charData = character.data as unknown as CharacterHitDiceData;
        const pools = Array.isArray(charData.hitDice) ? (charData.hitDice as HitDiceEntry[]) : null;
        if (!pools || !pools[index]) return { error: 'No hit dice pool at that position' };
        const remaining = typeof pools[index].remaining === 'number' ? pools[index].remaining : 0;
        if (remaining <= 0) return { error: 'No hit dice remaining to spend' };
        pools[index].remaining = remaining - 1;

        const saved = await tx.character.update({
          where: { id: characterId },
          data: { data: toJson(charData) },
          include: { campaign: { select: { id: true, name: true } } },
        });
        return { saved };
      });

      if ('error' in outcome) {
        socket.emit('error', { message: outcome.error });
        return;
      }

      try {
        const recipients = await getCharacterSheetRecipientIds(campaignId, characterId, outcome.saved.userId);
        const updatedBy = await resolveUpdatedBy(prisma, socket.userId!);
        io.to(recipients).emit('character.updated', {
          characterId,
          character: outcome.saved,
          userId: socket.userId,
          changedPaths: ['hitDice'],
          updatedBy,
        });
      } catch (error) {
        logger.error('Failed to broadcast hit die spend', { err: error });
      }

    } catch (error) {
      if (isCharacterLockTimeout(error)) {
        socket.emit('error', { message: CHARACTER_BUSY_MESSAGE });
        return;
      }
      logger.error('character.hitdice.spend failed', { err: error });
      socket.emit('error', { message: 'Failed to spend hit die' });
    }
  });
}
