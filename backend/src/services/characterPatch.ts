import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { GameSystem } from '../game-systems';
import { ValidationResult } from '../validators/game-systems';
import { deepEqual, getAtPath, isPlainObject, isSafePath, setAtPath } from '../utils/character-paths';

/**
 * Character Field-Level PATCH
 * Compare-and-set merge of `{ path, base, value }` changes into character data,
 * so the web editor, co-DMs and the MCP server can edit the same sheet without
 * silently overwriting each other. Path rules live in utils/character-paths.
 */

export const MAX_CHANGES = 200;
export const MAX_ATTEMPTS = 3;

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
 * Apply changes in order. A change applies when the current value at its path
 * deep-equals `base`; when the current value already equals `value` it counts
 * as applied (idempotent retry); otherwise it is a conflict. Changes are
 * evaluated against the data as modified by the preceding changes.
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
    const current = getAtPath(next, path);
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
  prisma: Pick<PrismaClient, 'character'>;
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
 * Read → merge → validate → conditional write on `updatedAt`. When the write
 * hits 0 rows (someone else wrote in between) the whole algorithm re-runs on a
 * fresh read, up to MAX_ATTEMPTS; after that every change is a conflict.
 * With `atomic`, any conflict aborts the whole change set: nothing is written
 * and `applied` is empty.
 */
export async function patchCharacterData(
  deps: CharacterPatchDeps,
  input: { id: string; changes: Change[]; atomic?: boolean }
): Promise<PatchCharacterResult> {
  const { prisma, validate } = deps;
  const { id, changes, atomic = false } = input;

  // Reject malformed requests before touching the database.
  applyCharacterChanges({}, changes);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const character = await prisma.character.findUnique({ where: { id }, include: characterInclude });
    if (!character) {
      return { status: 'not_found' };
    }

    const currentData = isPlainObject(character.data) ? character.data : {};
    const result = applyCharacterChanges(currentData, changes);

    if (atomic && result.conflicts.length > 0) {
      return {
        status: 'ok',
        written: false,
        character,
        applied: [],
        conflicts: result.conflicts,
      };
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

    const { count } = await prisma.character.updateMany({
      where: { id, updatedAt: character.updatedAt },
      data: { data: result.data as Prisma.InputJsonValue },
    });

    if (count === 1) {
      const saved = await prisma.character.findUnique({ where: { id }, include: characterInclude });
      if (!saved) {
        return { status: 'not_found' };
      }
      return {
        status: 'ok',
        written: true,
        character: saved,
        applied: result.applied,
        conflicts: result.conflicts,
      };
    }
  }

  // Lost the race MAX_ATTEMPTS times: report every change against the latest state.
  const latest = await prisma.character.findUnique({ where: { id }, include: characterInclude });
  if (!latest) {
    return { status: 'not_found' };
  }
  const latestData = isPlainObject(latest.data) ? latest.data : {};
  return {
    status: 'ok',
    written: false,
    character: latest,
    applied: [],
    conflicts: changes.map(({ path, base, value }) => ({
      path,
      base,
      current: getAtPath(latestData, path),
      attempted: value,
    })),
  };
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
