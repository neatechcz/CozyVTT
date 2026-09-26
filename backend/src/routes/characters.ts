import { Router, Response, json } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middleware/rbac';
import { authenticated } from '../middleware/compose';
import { prisma } from '../config/database';
import { normalizeAssetUrl } from '../utils/asset-urls';
import { diffPaths, isSafePath } from '../utils/character-paths';
import { GameSystem } from '../game-systems';
import { validateCharacterData } from '../validators/game-systems';
import { CreateCharacterSchema, UpdateCharacterSchema } from '../validators/characters';
import {
  CharacterTx,
  withCharacterRowLock,
  isCharacterLockTimeout,
  CHARACTER_BUSY_MESSAGE,
} from '../services/characterLock';
import {
  InvalidPathError,
  MAX_CHANGES,
  TooManyChangesError,
  patchCharacterData,
  resolveUpdatedBy,
} from '../services/characterPatch';
import { broadcastToCampaign, broadcastToCharacterViewers } from '../websocket/utils';
import logger from '../utils/logger';

const router = Router();

/**
 * Character Management Routes
 * Character Management
 */

/**
 * Body parser for PATCH /api/characters/:id/data: a full change set (up to
 * 200 whole-array values) can exceed the global 100kb JSON limit. server.ts
 * mounts it before the global express.json(), which then skips the
 * already-parsed body; the route mounts it too (a no-op after the first).
 */
export const characterDataPatchBodyParser = json({ limit: '1mb' });

/** PATCH /api/characters/:id/data body */
const PatchCharacterDataSchema = z.object({
  changes: z
    .array(
      z.object({
        path: z.string().refine(isSafePath, 'Invalid change path'),
        base: z.unknown(),
        value: z.unknown(),
      })
    )
    .max(MAX_CHANGES, `At most ${MAX_CHANGES} changes per request`),
  /** true: any conflict aborts the whole change set (nothing written, 409) */
  atomic: z.boolean().optional(),
});

/**
 * Edit permission shared by PUT and PATCH: the character owner, a DM of the
 * campaign the character is in, or a PLAYER of that campaign the character is
 * assigned to (delegated character control). Pass the transaction client to
 * evaluate it against the row read under the character row lock.
 */
async function canEditCharacter(
  userId: string,
  character: { id: string; userId: string; campaignId: string | null },
  db: Pick<CharacterTx, 'campaignMembership'> = prisma
): Promise<boolean> {
  // Owner can always edit
  if (character.userId === userId) {
    return true;
  }

  // In a campaign: its DM, or the player the character is assigned to
  if (character.campaignId) {
    const membership = await db.campaignMembership.findUnique({
      where: {
        userId_campaignId: {
          userId,
          campaignId: character.campaignId,
        },
      },
    });

    if (membership && (membership.role === 'DM' ||
      (membership.role === 'PLAYER' && membership.characterIds.includes(character.id)))) {
      return true;
    }
  }

  return false;
}

/**
 * Send `character.updated` to everyone who may open the character's full
 * sheet (owner, campaign DMs, assigned player) — never the campaign room.
 * Payload: { characterId, character, userId, changedPaths, updatedBy }.
 * `changedPaths` may contain "" meaning "the whole document changed".
 * Call only after the write has committed. Never throws — a failed broadcast
 * must not fail the request.
 */
async function broadcastCharacterUpdated(
  character: { id: string; campaignId: string | null; userId: string },
  userId: string,
  changedPaths: string[]
): Promise<void> {
  if (!character.campaignId) return;

  try {
    const updatedBy = await resolveUpdatedBy(prisma, userId);
    await broadcastToCharacterViewers(character, 'character.updated', {
      characterId: character.id,
      character,
      userId,
      changedPaths,
      updatedBy,
    });
  } catch (error) {
    logger.error('Failed to broadcast character update', { err: error });
  }
}

function formatValidationErrors(errors: z.ZodError) {
  return errors.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * POST /api/characters
 * Create a new character
 * Requires: Authentication
 */
router.post('/', authenticated, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.session.userId!;

    const parsed = CreateCharacterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation Error',
        message: parsed.error.issues[0]?.message ?? 'Invalid character data',
      });
    }
    const { name, data, tokenImageUrl, gameSystem, campaignId } = parsed.data;

    // Determine final gameSystem value
    let finalGameSystem = gameSystem;

    // If creating for a campaign and no gameSystem provided, inherit from campaign
    if (campaignId && !gameSystem) {
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { gameSystem: true },
      });

      if (campaign) {
        // Prisma's GameSystem is a string-literal union; cast to the local enum
        // type finalGameSystem was inferred from (identical string values).
        finalGameSystem = campaign.gameSystem as GameSystem | null;
      }
    }

    // Validate gameSystem if provided
    if (finalGameSystem !== undefined && finalGameSystem !== null) {
      const validSystems: string[] = [
        GameSystem.DND_5E,
        GameSystem.PATHFINDER_2E,
        GameSystem.SHADOWRUN_6E,
        GameSystem.CALL_OF_CTHULHU_7E,
      ];
      if (!validSystems.includes(finalGameSystem as string)) {
        return res.status(400).json({
          error: 'Validation Error',
          message: `Invalid game system. Must be one of: ${validSystems.join(', ')}`,
        });
      }

      // Validate character data against schema if gameSystem is specified
      const validationResult = validateCharacterData(finalGameSystem as GameSystem, data || {});
      if (!validationResult.success) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Character data does not match game system schema',
          validationErrors: validationResult.errors.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })),
        });
      }
    }

    // Create character with flexible JSON data field
    // Normalize tokenImageUrl to full path if provided
    const normalizedTokenImageUrl = tokenImageUrl ? normalizeAssetUrl(tokenImageUrl, 'tokens') : null;

    const character = await prisma.character.create({
      data: {
        userId,
        name,
        data: data || {}, // Default to empty object if no data provided
        tokenImageUrl: normalizedTokenImageUrl,
        campaignId: campaignId || null,
        gameSystem: finalGameSystem || null,
      },
    });

    return res.status(201).json({
      message: 'Character created successfully',
      character,
    });
  } catch (error) {
    logger.error('Error creating character', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create character',
    });
  }
});

/**
 * GET /api/characters
 * List characters owned by the user, assigned to the player, or in a campaign they DM
 * Requires: Authentication
 */
router.get('/', authenticated, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.session.userId!;
    const memberships = await prisma.campaignMembership.findMany({
      where: { userId, role: { in: ['PLAYER', 'DM'] } },
      select: { campaignId: true, characterIds: true, role: true },
    });

    const characters = await prisma.character.findMany({
      where: {
        OR: [
          { userId },
          ...memberships.map((membership) =>
            membership.role === 'DM'
              ? { campaignId: membership.campaignId }
              : { campaignId: membership.campaignId, id: { in: membership.characterIds } },
          ),
        ],
      },
      include: {
        campaign: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return res.status(200).json({ characters });
  } catch (error) {
    logger.error('Error fetching characters', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch characters',
    });
  }
});

/**
 * GET /api/characters/templates/:gameSystem/:templateName
 * Get a specific character template for a game system
 * Requires: Authentication
 * NOTE: This route MUST come before GET /:id to avoid route conflicts
 */
router.get(
  '/templates/:gameSystem/:templateName',
  authenticated,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { gameSystem, templateName } = req.params;

      // Handle flexible templates (no game system)
      if (!gameSystem || gameSystem === 'null' || gameSystem === 'undefined') {
        const { FLEXIBLE_TEMPLATES } = await import(
          '../utils/character-templates/flexible-templates'
        );
        const template = FLEXIBLE_TEMPLATES[templateName];

        if (!template) {
          return res.status(404).json({
            error: 'Template Not Found',
            message: `Template '${templateName}' not found for flexible characters`,
          });
        }

        return res.status(200).json({
          message: 'Template retrieved successfully',
          ...template,
        });
      }

      // Validate game system
      if (!Object.values(GameSystem).includes(gameSystem as GameSystem)) {
        return res.status(400).json({
          error: 'Validation Error',
          message: `Invalid game system: ${gameSystem}`,
        });
      }

      // Import template functions
      const { getCharacterTemplate } = await import('../utils/character-templates');

      // Get the template
      const template = getCharacterTemplate(gameSystem as GameSystem, templateName);

      return res.status(200).json({
        message: 'Template retrieved successfully',
        ...template,
      });
    } catch (error) {
      logger.error('Error fetching character template', { err: error });
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to fetch character template',
      });
    }
  }
);

/**
 * GET /api/characters/:id
 * Get a specific character
 * Requires: Authentication
 * Authorization: Character owner OR campaign DM (if character is in a campaign)
 */
router.get('/:id', authenticated, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { id } = req.params;

    const character = await prisma.character.findUnique({
      where: { id },
      include: {
        campaign: {
          select: {
            id: true,
            name: true,
          },
        },
        user: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
            // SECURITY: never embed email in a player-facing response.
          },
        },
      },
    });

    if (!character) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Character not found',
      });
    }

    // Check authorization: owner can always view
    if (character.userId === userId) {
      return res.status(200).json({ character });
    }

    // A campaign DM or assigned player may view the full sheet.
    if (character.campaignId) {
      const membership = await prisma.campaignMembership.findUnique({
        where: {
          userId_campaignId: {
            userId,
            campaignId: character.campaignId,
          },
        },
      });

      if (membership && (membership.role === 'DM' ||
        (membership.role === 'PLAYER' && membership.characterIds.includes(id)))) {
        return res.status(200).json({ character });
      }
    }

    // Not authorized
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have permission to view this character',
    });
  } catch (error) {
    logger.error('Error fetching character', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch character',
    });
  }
});

/**
 * GET /api/characters/:id/validate
 * Validate character data against game system schema
 * Requires: Authentication
 * Authorization: Character owner only
 */
router.get('/:id/validate', authenticated, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { id } = req.params;

    const character = await prisma.character.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        gameSystem: true,
        data: true,
      },
    });

    if (!character) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Character not found',
      });
    }

    // Only character owner can validate (prevent info leakage)
    if (character.userId !== userId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to validate this character',
      });
    }

    // Cannot validate without a game system
    if (!character.gameSystem) {
      return res.status(400).json({
        isValid: false,
        errors: [{
          path: 'gameSystem',
          message: 'Character has no game system assigned',
          code: 'no_game_system',
        }],
      });
    }

    // Validate character data
    try {
      validateCharacterData(character.gameSystem as any, character.data);

      return res.status(200).json({
        isValid: true,
      });
    } catch (error: any) {
      // Validation failed - return detailed errors
      if (error.errors) {
        const formattedErrors = error.errors.map((err: any) => ({
          path: err.path.join('.') || 'root',
          message: err.message,
          code: err.code,
        }));

        return res.status(200).json({
          isValid: false,
          errors: formattedErrors,
        });
      }

      // Unknown validation error
      return res.status(200).json({
        isValid: false,
        errors: [{
          path: 'unknown',
          message: error.message || 'Unknown validation error',
          code: 'unknown',
        }],
      });
    }
  } catch (error) {
    logger.error('Error validating character', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to validate character',
    });
  }
});

/**
 * PUT /api/characters/:id
 * Update a character
 * Requires: Authentication
 * Authorization: Character owner OR campaign DM OR the campaign PLAYER the
 * character is assigned to — checked early and again under the row lock
 * Precondition: optional `expectedUpdatedAt` (ISO 8601). When present and not
 * equal to the locked row's `updatedAt` → 409 { error: 'Conflict', message,
 * character } (the current character) and nothing is written. Absent → the
 * write is unconditional (backward compatible).
 */
router.put('/:id', authenticated, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { id } = req.params;

    const parsed = UpdateCharacterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation Error',
        message: parsed.error.issues[0]?.message ?? 'Invalid character data',
      });
    }
    const { name, data, tokenImageUrl, gameSystem, expectedUpdatedAt } = parsed.data;
    const expectedTime = expectedUpdatedAt !== undefined ? new Date(expectedUpdatedAt).getTime() : undefined;

    // Find character first to check authorization
    const character = await prisma.character.findUnique({
      where: { id },
    });

    if (!character) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Character not found',
      });
    }

    // Prevent changing gameSystem after creation
    if (gameSystem !== undefined && gameSystem !== character.gameSystem) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot change game system after character creation. Create a new character instead.',
      });
    }

    // Check authorization (early, unlocked: no validation feedback or lock
    // wait for someone who may not edit; re-checked under the row lock below)
    if (!(await canEditCharacter(userId, character))) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to edit this character',
      });
    }

    // Validate data update if character has gameSystem
    if (character.gameSystem && data !== undefined) {
      const validationResult = validateCharacterData(character.gameSystem as GameSystem, data);
      if (!validationResult.success) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Character data does not match game system schema',
          validationErrors: formatValidationErrors(validationResult.errors),
        });
      }
    }

    // Build update data
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (data !== undefined) updateData.data = data;
    if (tokenImageUrl !== undefined) {
      // Normalize tokenImageUrl to full path (or null)
      updateData.tokenImageUrl = tokenImageUrl ? normalizeAssetUrl(tokenImageUrl, 'tokens') : null;
    }

    // Read and write under the character row lock (serialised with PATCH and
    // the HP socket handler); diff against the locked row, not the unlocked
    // read above, so changes this PUT overwrites show up in changedPaths.
    // The permission rules are evaluated again against the locked row: the
    // character's campaign or the caller's assignment may have changed since
    // the unlocked read, and nothing can change them while the lock is held.
    const locked = await withCharacterRowLock(prisma, id, async (tx) => {
      const lockedCharacter = await tx.character.findUnique({ where: { id } });
      if (!lockedCharacter) return { status: 'not_found' as const };
      if (!(await canEditCharacter(userId, lockedCharacter, tx))) {
        return { status: 'forbidden' as const };
      }
      // Precondition (after the permission check: the current character is
      // only ever returned to someone who may edit it)
      if (expectedTime !== undefined && new Date(lockedCharacter.updatedAt).getTime() !== expectedTime) {
        const current = await tx.character.findUnique({
          where: { id },
          include: { campaign: { select: { id: true, name: true } } },
        });
        return { status: 'conflict' as const, current };
      }

      const updated = await tx.character.update({
        where: { id },
        data: updateData,
        include: {
          campaign: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });
      return { status: 'ok' as const, before: lockedCharacter, updated };
    });

    if (locked.status === 'not_found') {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Character not found',
      });
    }
    if (locked.status === 'forbidden') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to edit this character',
      });
    }
    if (locked.status === 'conflict') {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Character changed since it was loaded',
        character: locked.current,
      });
    }
    const updatedCharacter = locked.updated;

    // Send the update to everyone who may open the sheet (campaign characters).
    // changedPaths may contain "" — the whole document changed (its root is
    // not a path-addressable object); clients must treat that as "reload all".
    await broadcastCharacterUpdated(
      updatedCharacter,
      userId,
      diffPaths(locked.before.data, updatedCharacter.data)
    );

    return res.status(200).json({
      message: 'Character updated successfully',
      character: updatedCharacter,
    });
  } catch (error) {
    if (isCharacterLockTimeout(error)) {
      // The row lock was not obtained in time (another writer holds it)
      res.set('Retry-After', '1');
      return res.status(503).json({
        error: 'Service Unavailable',
        message: CHARACTER_BUSY_MESSAGE,
      });
    }
    logger.error('Error updating character', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update character',
    });
  }
});

/**
 * PATCH /api/characters/:id/data
 * Field-level compare-and-set update of character data.
 * Body: { changes: [{ path, base, value }] (max 200), atomic?: boolean }
 * 200 { character, applied, conflicts } — 409 same body when nothing applied
 * and there are conflicts (with atomic: any conflict → nothing written, 409)
 * — 400 with validationErrors when the merged data fails the game-system
 * schema (nothing written).
 * Requires: Authentication
 * Authorization: same as PUT (owner OR campaign DM OR assigned campaign
 * PLAYER), checked early and again under the row lock
 */
router.patch('/:id/data', characterDataPatchBodyParser, authenticated, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { id } = req.params;

    const parsed = PatchCharacterDataSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation Error',
        message: parsed.error.issues[0]?.message ?? 'Invalid change set',
      });
    }

    const character = await prisma.character.findUnique({
      where: { id },
    });

    if (!character) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Character not found',
      });
    }

    // Early, unlocked check; patchCharacterData re-checks under the row lock
    if (!(await canEditCharacter(userId, character))) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to edit this character',
      });
    }

    let result;
    try {
      result = await patchCharacterData(
        { prisma, validate: validateCharacterData },
        {
          id,
          changes: parsed.data.changes.map(({ path, base, value }) => ({ path, base, value })),
          atomic: parsed.data.atomic ?? false,
          authorize: (lockedCharacter, tx) => canEditCharacter(userId, lockedCharacter, tx),
        }
      );
    } catch (error) {
      if (error instanceof InvalidPathError || error instanceof TooManyChangesError) {
        return res.status(400).json({
          error: 'Validation Error',
          message: error.message,
        });
      }
      throw error;
    }

    if (result.status === 'not_found') {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Character not found',
      });
    }

    if (result.status === 'forbidden') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to edit this character',
      });
    }

    if (result.status === 'invalid') {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Character data does not match game system schema',
        validationErrors: formatValidationErrors(result.errors),
      });
    }

    const { character: updatedCharacter, applied, conflicts, written } = result;

    if (written) {
      await broadcastCharacterUpdated(updatedCharacter, userId, applied);
    }

    const status = applied.length === 0 && conflicts.length > 0 ? 409 : 200;
    return res.status(status).json({ character: updatedCharacter, applied, conflicts });
  } catch (error) {
    if (isCharacterLockTimeout(error)) {
      // The row lock was not obtained in time (another writer holds it)
      res.set('Retry-After', '1');
      return res.status(503).json({
        error: 'Service Unavailable',
        message: CHARACTER_BUSY_MESSAGE,
      });
    }
    logger.error('Error patching character data', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update character',
    });
  }
});

/**
 * DELETE /api/characters/:id
 * Delete a character
 * Requires: Authentication
 * Authorization: Character owner only
 */
router.delete('/:id', authenticated, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { id } = req.params;

    const character = await prisma.character.findUnique({
      where: { id },
    });

    if (!character) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Character not found',
      });
    }

    // Only owner can delete
    if (character.userId !== userId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Only the character owner can delete this character',
      });
    }

    await prisma.character.delete({
      where: { id },
    });

    return res.status(200).json({
      message: 'Character deleted successfully',
    });
  } catch (error) {
    logger.error('Error deleting character', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete character',
    });
  }
});

/**
 * POST /api/characters/:id/assign
 * Assign a character to a campaign (or unassign if campaignId is null/empty)
 * Requires: Authentication
 * Authorization: Character owner only
 * Validation: User must be a member of the target campaign (if assigning)
 */
router.post('/:id/assign', authenticated, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { id } = req.params;
    const { campaignId } = req.body;

    const character = await prisma.character.findUnique({
      where: { id },
    });

    if (!character) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Character not found',
      });
    }

    // Only owner can assign/unassign character
    if (character.userId !== userId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Only the character owner can assign this character to a campaign',
      });
    }

    // Handle unassignment (campaignId is null, empty string, or undefined)
    if (!campaignId || campaignId === '') {
      // Remove from previous campaign's membership characterIds if assigned
      if (character.campaignId) {
        const previousMembership = await prisma.campaignMembership.findUnique({
          where: {
            userId_campaignId: {
              userId,
              campaignId: character.campaignId,
            },
          },
        });

        if (previousMembership) {
          await prisma.campaignMembership.update({
            where: {
              userId_campaignId: {
                userId,
                campaignId: character.campaignId,
              },
            },
            data: {
              characterIds: previousMembership.characterIds.filter((cId) => cId !== id),
            },
          });
        }
      }

      const updatedCharacter = await prisma.character.update({
        where: { id },
        data: { campaignId: null },
        include: {
          campaign: {
            select: {
              id: true,
              name: true,
              gameSystem: true,
            },
          },
        },
      });

      // Broadcast roster.updated WebSocket event
      if (character.campaignId) {
        try {
          broadcastToCampaign(character.campaignId, 'roster.updated', {
            action: 'character.unassigned',
            characterId: id,
            userId,
          });
        } catch (error) {
          logger.error('Failed to broadcast roster update', { err: error });
          // Don't fail the request if broadcast fails
        }
      }

      return res.status(200).json({
        message: 'Character unassigned from campaign successfully',
        character: updatedCharacter,
      });
    }

    // Handle assignment - validate campaign exists and user is a member
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        name: true,
        gameSystem: true,
      },
    });

    if (!campaign) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Campaign not found',
      });
    }

    // Check if user is a member of the campaign
    const membership = await prisma.campaignMembership.findUnique({
      where: {
        userId_campaignId: {
          userId,
          campaignId,
        },
      },
    });

    if (!membership) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You must be a member of the campaign to assign a character to it',
      });
    }

    // Enforce game system compatibility:
    // flexible character (null) only goes to flexible campaigns (null), and vice versa.
    // typed characters must match the campaign's game system exactly.
    const charSystem = character.gameSystem;
    const campSystem = campaign.gameSystem;
    const systemsCompatible =
      (!charSystem && !campSystem) ||
      (charSystem && campSystem && charSystem === campSystem);

    if (!systemsCompatible) {
      const charLabel = charSystem ?? 'flexible';
      const campLabel = campSystem ?? 'flexible';
      return res.status(400).json({
        error: 'Game System Mismatch',
        message: `Cannot assign a ${charLabel} character to a ${campLabel} campaign. Character and campaign game systems must match.`,
      });
    }

    // Remove from previous campaign's membership if changing campaigns
    if (character.campaignId && character.campaignId !== campaignId) {
      const previousMembership = await prisma.campaignMembership.findUnique({
        where: {
          userId_campaignId: {
            userId,
            campaignId: character.campaignId,
          },
        },
      });

      if (previousMembership) {
        await prisma.campaignMembership.update({
          where: {
            userId_campaignId: {
              userId,
              campaignId: character.campaignId,
            },
          },
          data: {
            characterIds: previousMembership.characterIds.filter((cId) => cId !== id),
          },
        });
      }
    }

    // Add to new campaign's membership characterIds
    if (!membership.characterIds.includes(id)) {
      await prisma.campaignMembership.update({
        where: {
          userId_campaignId: {
            userId,
            campaignId,
          },
        },
        data: {
          characterIds: [...membership.characterIds, id],
        },
      });
    }

    // Assign character to campaign
    const updatedCharacter = await prisma.character.update({
      where: { id },
      data: { campaignId },
      include: {
        campaign: {
          select: {
            id: true,
            name: true,
            gameSystem: true,
          },
        },
      },
    });

    // Broadcast roster.updated WebSocket event
    try {
      broadcastToCampaign(campaignId, 'roster.updated', {
        action: 'character.assigned',
        characterId: id,
        userId,
        campaignId,
      });
    } catch (error) {
      logger.error('Failed to broadcast roster update', { err: error });
      // Don't fail the request if broadcast fails
    }

    return res.status(200).json({
      message: 'Character assigned to campaign successfully',
      character: updatedCharacter,
    });
  } catch (error) {
    logger.error('Error assigning character to campaign', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to assign character to campaign',
    });
  }
});

/**
 * POST /api/characters/:id/copy
 * Create a copy of an existing character
 * Requires: Authentication
 * Authorization: Character owner only
 */
router.post('/:id/copy', authenticated, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { id } = req.params;

    // Fetch the original character
    const originalCharacter = await prisma.character.findUnique({
      where: { id },
    });

    if (!originalCharacter) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Character not found',
      });
    }

    // Check ownership
    if (originalCharacter.userId !== userId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to copy this character',
      });
    }

    // Create a copy with modified name
    const copiedCharacter = await prisma.character.create({
      data: {
        userId,
        name: `${originalCharacter.name} (Copy)`,
        data: originalCharacter.data as any, // Type assertion for Prisma JSON compatibility
        tokenImageUrl: originalCharacter.tokenImageUrl,
        gameSystem: originalCharacter.gameSystem,
        campaignId: null, // Copies are unassigned by default
      },
    });

    return res.status(201).json({
      message: 'Character copied successfully',
      character: copiedCharacter,
    });
  } catch (error) {
    logger.error('Error copying character', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to copy character',
    });
  }
});

export default router;
