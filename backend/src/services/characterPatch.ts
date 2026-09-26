import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { GameSystem } from '../game-systems';
import { ValidationResult } from '../validators/game-systems';
import { deepEqual, isPlainObject, isSafePath, resolvePath, setAtPath } from '../utils/character-paths';
import { CharacterTx, withCharacterRowLock } from './characterLock';

/**
 * Character Field-Level PATCH
 * Compare-and-set merge of `{ path, base, value }` changes into character data,
 * so the web editor, co-DMs and the MCP server can edit the same sheet without
 * silently overwriting each other. Path rules live in utils/character-paths.
 */

export const MAX_CHANGES = 200;

export interface Change {
  path: string;
  base: unknown;
  value: unknown;
}

export interface Conflict {
  path: string;
  base: unknown;
  current: unknown;
  attempted: unknown;
}

export class InvalidPathError extends Error {
  constructor(public readonly path: string) {
    super(`Invalid change path: ${JSON.stringify(path)}`);
    this.name = 'InvalidPathError';
  }
}

export class TooManyChangesError extends Error {
  constructor(count: number) {
    super(`Too many changes: ${count} (maximum ${MAX_CHANGES})`);
    this.name = 'TooManyChangesError';
  }
}

/**
 * The value a conflict reports as `current`: the value at the path, or — when
 * the path is blocked by an existing array / null / primitive — that value.
 */
function currentForConflict(data: unknown, path: string): unknown {
  const resolved = resolvePath(data, path);
  if (resolved.kind === 'missing') return undefined;
  return resolved.value;
}

/**
 * Apply changes in order. A change applies when the current value at its path
 * deep-equals `base`; when the current value already equals `value` it counts
 * as applied (idempotent retry); otherwise it is a conflict. A path that
 * passes through an existing array, `null` or primitive is always a conflict
 * whose `current` is that blocking value — nothing is ever written into or
 * through it; only missing intermediate objects are created.
 * Changes are evaluated against the data as modified by the preceding changes.
 * Throws before applying anything if a path is unsafe or there are too many.
 * Never mutates `data`.
 */
export function applyCharacterChanges(
  data: Record<string, unknown>,
  changes: Change[]
): { data: Record<string, unknown>; applied: string[]; conflicts: Conflict[] } {
  if (changes.length > MAX_CHANGES) {
    throw new TooManyChangesError(changes.length);
  }
  for (const change of changes) {
    if (!isSafePath(change.path)) {
      throw new InvalidPathError(change.path);
    }
  }

  let next = data;
  const applied: string[] = [];
  const conflicts: Conflict[] = [];

  for (const { path, base, value } of changes) {
    const resolved = resolvePath(next, path);
    if (resolved.kind === 'blocked') {
      conflicts.push({ path, base, current: resolved.value, attempted: value });
      continue;
    }

    const current = resolved.kind === 'value' ? resolved.value : undefined;
    if (deepEqual(current, base)) {
      next = setAtPath(next, path, value);
      applied.push(path);
    } else if (deepEqual(current, value)) {
      applied.push(path);
    } else {
      conflicts.push({ path, base, current, attempted: value });
    }
  }

  return { data: next, applied, conflicts };
}

export interface CharacterPatchDeps {
  prisma: Pick<PrismaClient, '$transaction'>;
  validate: (gameSystem: GameSystem, data: unknown) => ValidationResult<unknown>;
}

const characterInclude = {
  campaign: {
    select: {
      id: true,
      name: true,
    },
  },
} as const;

type PatchedCharacter = Prisma.CharacterGetPayload<{ include: typeof characterInclude }>;

export type PatchCharacterResult =
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'invalid'; errors: z.ZodError }
  | {
      status: 'ok';
      /** true when the data was actually written (callers broadcast only then) */
      written: boolean;
      character: PatchedCharacter;
      applied: string[];
      conflicts: Conflict[];
    };

/**
 * Lock the row → read → merge → validate → write, all in one transaction
 * (withCharacterRowLock), so concurrent PATCH / PUT / HP writers serialise
 * and each sees the previous one's result. Broadcast after this resolves,
 * i.e. after commit.
 * With `atomic`, any conflict aborts the whole change set: nothing is written
 * and `applied` is empty.
 *
 * The write keeps the `updatedAt` condition as defence in depth. While the
 * row lock is held no other UPDATE of the row can commit, so it cannot hit
 * 0 rows; if it ever does (a future code path that bypasses the lock), every
 * change is reported as a conflict against a fresh read and the client
 * re-reads — there is no retry loop.
 */
export async function patchCharacterData(
  deps: CharacterPatchDeps,
  input: {
    id: string;
    changes: Change[];
    atomic?: boolean;
    /**
     * Edit permission evaluated against the row read under the lock (its
     * campaign / the caller's assignment cannot change while it is held).
     * false → { status: 'forbidden' }, nothing written.
     */
    authorize?: (
      character: { id: string; userId: string; campaignId: string | null },
      tx: CharacterTx
    ) => Promise<boolean>;
  }
): Promise<PatchCharacterResult> {
  const { prisma, validate } = deps;
  const { id, changes, atomic = false, authorize } = input;

  // Reject malformed requests before touching the database.
  applyCharacterChanges({}, changes);

  return withCharacterRowLock(prisma, id, async (tx): Promise<PatchCharacterResult> => {
    const character = await tx.character.findUnique({ where: { id }, include: characterInclude });
    if (!character) {
      return { status: 'not_found' };
    }
    if (authorize && !(await authorize(character, tx))) {
      return { status: 'forbidden' };
    }

    const currentData = isPlainObject(character.data) ? character.data : {};
    const result = applyCharacterChanges(currentData, changes);

    if (atomic && result.conflicts.length > 0) {
      return { status: 'ok', written: false, character, applied: [], conflicts: result.conflicts };
    }

    if (deepEqual(result.data, currentData)) {
      return {
        status: 'ok',
        written: false,
        character,
        applied: result.applied,
        conflicts: result.conflicts,
      };
    }

    if (character.gameSystem) {
      const validation = validate(character.gameSystem as GameSystem, result.data);
      if (!validation.success) {
        return { status: 'invalid', errors: validation.errors };
      }
    }

    const { count } = await tx.character.updateMany({
      where: { id, updatedAt: character.updatedAt },
      data: { data: result.data as Prisma.InputJsonValue },
    });

    const saved = await tx.character.findUnique({ where: { id }, include: characterInclude });
    if (!saved) {
      return { status: 'not_found' };
    }

    if (count !== 1) {
      const savedData = isPlainObject(saved.data) ? saved.data : {};
      return {
        status: 'ok',
        written: false,
        character: saved,
        applied: [],
        conflicts: changes.map(({ path, base, value }) => ({
          path,
          base,
          current: currentForConflict(savedData, path),
          attempted: value,
        })),
      };
    }

    return {
      status: 'ok',
      written: true,
      character: saved,
      applied: result.applied,
      conflicts: result.conflicts,
    };
  });
}

/**
 * `updatedBy` for `character.updated` broadcasts.
 */
export async function resolveUpdatedBy(
  prisma: Pick<PrismaClient, 'user'>,
  userId: string
): Promise<{ userId: string; displayName: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
  return { userId, displayName: user?.displayName ?? 'Unknown' };
}
