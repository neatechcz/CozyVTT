// ============================================
// Three-way merge of character data
// Used by the live D&D 5e editor: `base` is the last server state the editor
// knows, `local` what the user has in the form, `remote` the new server state.
// ============================================

import { deepEqual, diffPaths, getAtPath, isSafePath, resolvePath, setAtPath } from './character-paths';

export { diffPaths } from './character-paths';

export type CharacterDataObject = Record<string, any>;

export interface ResetField {
  path: string;
  /** The user's value that was overwritten */
  mine: unknown;
  /** The value someone else saved */
  theirs: unknown;
}

export interface CharacterChange {
  path: string;
  base: unknown;
  value: unknown;
}

/** Deep copy of JSON character data (never shares objects with the input). */
export function cloneData<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Merge a remote update into the user's local data:
 * - untouched locally → remote value;
 * - changed locally only → local value;
 * - changed by both to different values → remote value + reset entry;
 * - changed by both to the same value → no reset.
 * Paths come from `diffPaths(base, local)`; whether the remote changed a
 * path is decided on the subtree at that path, so granularity mismatches
 * (local replaced an object, remote changed one of its fields) still conflict.
 */
export function mergeRemoteUpdate<T extends CharacterDataObject>(
  base: CharacterDataObject,
  local: CharacterDataObject,
  remote: T,
): { data: T; resetFields: ResetField[] } {
  let data = cloneData(remote);
  const resetFields: ResetField[] = [];

  const blockedPrefixes = new Set<string>();

  for (const path of diffPaths(base, local)) {
    const mine = getAtPath(local, path);

    // The remote replaced an object on this path with an array, `null` or a
    // primitive (diffPaths only descends where base and local are objects,
    // so base had an object there): that counts as a remote change of the
    // whole prefix — keep the remote value, reset the user's object once.
    const resolved = path === '' ? null : resolvePath(remote, path);
    if (resolved?.kind === 'blocked') {
      if (!blockedPrefixes.has(resolved.prefix)) {
        blockedPrefixes.add(resolved.prefix);
        const minePrefix = getAtPath(local, resolved.prefix);
        if (!deepEqual(minePrefix, resolved.value)) {
          resetFields.push({
            path: resolved.prefix,
            mine: cloneData(minePrefix),
            theirs: cloneData(resolved.value),
          });
        }
      }
      continue;
    }

    const theirs = getAtPath(remote, path);
    const remoteChanged = !deepEqual(getAtPath(base, path), theirs);

    if (!remoteChanged) {
      // `""` = the root is not path-addressable: the whole document is the leaf
      data = path === '' ? cloneData(mine as T) : setAtPath(data, path, cloneData(mine));
    } else if (!deepEqual(mine, theirs)) {
      resetFields.push({ path, mine: cloneData(mine), theirs: cloneData(theirs) });
    }
  }

  return { data, resetFields };
}

/**
 * True when the difference cannot be expressed as field-level changes (the
 * whole-document path `""` or an unsafe segment) — save with the full PUT.
 */
export function needsFullDocumentSave(
  base: CharacterDataObject,
  local: CharacterDataObject,
): boolean {
  return diffPaths(base, local).some((path) => !isSafePath(path));
}

/**
 * Field-level changes for `PATCH /api/characters/:id/data`. Never emits the
 * whole-document path or an unsafe segment: throws instead — check
 * `needsFullDocumentSave` first.
 */
export function buildChanges(
  base: CharacterDataObject,
  local: CharacterDataObject,
): CharacterChange[] {
  const paths = diffPaths(base, local);
  const unsafe = paths.find((path) => !isSafePath(path));
  if (unsafe !== undefined) {
    throw new Error(`Change at "${unsafe}" cannot be sent as a field-level PATCH`);
  }
  return paths.map((path) => ({
    path,
    base: getAtPath(base, path),
    value: getAtPath(local, path),
  }));
}
