// ============================================
// useLiveCharacterSync
// Keeps an open D&D 5e character editor live while someone else (another
// player, the DM or the MCP game master) changes the same character.
//
// - `base`  = last server state the editor knows
// - `local` = what the user has in the form (reported by the editor)
// On `character.updated` the remote data is three-way merged into the local
// data and handed back to the editor as `externalData` (+ a bumped
// `externalDataVersion`). Fields the user edited and someone else changed
// are reset to the new value and collected in `resets`. `save()` sends only
// the changed fields via PATCH and resolves conflicts the same way.
// ============================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CharacterDataConflict } from '@/services/api';
import type { Character } from '@/types';
import {
  buildChanges,
  cloneData,
  mergeRemoteUpdate,
  needsFullDocumentSave,
  type CharacterDataObject,
  type ResetField,
} from '@/utils/characterMerge';
import { deepEqual, diffPaths, getAtPath } from '@/utils/character-paths';

export interface SheetResetAuthor {
  userId: string | null;
  displayName: string;
}

export interface SheetReset extends ResetField {
  author: SheetResetAuthor;
  /** When the reset happened (ms since epoch) */
  at: number;
}

/**
 * `user` — the change came from the user typing/clicking in the form;
 * `system` — the editor derived it (defaults, auto-calculated modifiers,
 * adopting external data). Only user changes can be "overwritten".
 */
export type LocalChangeOrigin = 'user' | 'system';

/** Minimal socket surface (matches `socketClient` from `@/services/socket`). */
export interface LiveSyncSocket {
  on(event: string, callback: (data: any) => void): void;
  off(event: string, callback?: (data: any) => void): void;
}

export interface CharacterUpdatedPayload {
  characterId: string;
  character: Character;
  userId?: string;
  changedPaths?: string[];
  updatedBy?: { userId: string; displayName: string };
}

export type LiveSaveOutcome =
  | { status: 'saved'; character: Character }
  | { status: 'unchanged' }
  | { status: 'conflicts'; character: Character; conflicts: CharacterDataConflict[] };

export interface UseLiveCharacterSyncOptions {
  character: Character | null;
  socket?: LiveSyncSocket | null;
  isDnd5e: boolean;
  /** Called with every newer server copy of the character (events, saves). */
  onServerCharacter?: (character: Character) => void;
}

export interface UseLiveCharacterSyncResult {
  externalData: CharacterDataObject | undefined;
  externalDataVersion: number;
  resets: SheetReset[];
  dismissResets: () => void;
  save: (localData: CharacterDataObject) => Promise<LiveSaveOutcome>;
  reportLocalChange: (data: CharacterDataObject, origin?: LocalChangeOrigin) => void;
  /** The user has edits that are not on the server */
  isDirty: boolean;
}

export const UNKNOWN_AUTHOR: SheetResetAuthor = { userId: null, displayName: 'někdo jiný' };

const CHARACTER_UPDATED = 'character.updated';

/** Same field, or one contains the other; `""` is the whole document. */
function pathsOverlap(a: string, b: string): boolean {
  return a === '' || b === '' || a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

export function useLiveCharacterSync({
  character,
  socket,
  isDnd5e,
  onServerCharacter,
}: UseLiveCharacterSyncOptions): UseLiveCharacterSyncResult {
  const [external, setExternal] = useState<{ data: CharacterDataObject | undefined; version: number }>({
    data: undefined,
    version: 0,
  });
  const [resets, setResets] = useState<SheetReset[]>([]);
  const [isDirty, setIsDirty] = useState(false);

  const trackedIdRef = useRef<string | null>(null);
  const baseRef = useRef<CharacterDataObject>({});
  const localRef = useRef<CharacterDataObject>({});
  /** Paths the user edited that still differ from `base` */
  const touchedRef = useRef<Set<string>>(new Set());
  const onServerCharacterRef = useRef(onServerCharacter);
  onServerCharacterRef.current = onServerCharacter;

  // Adopt the character synchronously (not in an effect): the editor is a
  // child, and child effects — including its first local report — run before
  // ours, so `base` must already be set when that report arrives.
  if (isDnd5e && character && trackedIdRef.current !== character.id) {
    trackedIdRef.current = character.id;
    baseRef.current = cloneData((character.data ?? {}) as CharacterDataObject);
    localRef.current = cloneData(baseRef.current);
    touchedRef.current = new Set();
  }

  const isTouched = (path: string): boolean => {
    for (const touched of touchedRef.current) {
      if (pathsOverlap(touched, path)) return true;
    }
    return false;
  };

  /** Drop touched paths that equal the server again, then publish `isDirty`. */
  const refreshDirty = () => {
    const touched = touchedRef.current;
    for (const path of [...touched]) {
      if (deepEqual(getAtPath(baseRef.current, path), getAtPath(localRef.current, path))) {
        touched.delete(path);
      }
    }
    setIsDirty(touched.size > 0);
  };

  const pushToEditor = (data: CharacterDataObject) => {
    setExternal((prev) => ({ data: cloneData(data), version: prev.version + 1 }));
  };

  /** Move `base` to a new server state, merging it into the local data. */
  const rebase = (serverData: CharacterDataObject, author: SheetResetAuthor) => {
    let next: CharacterDataObject;
    let newResets: SheetReset[] = [];

    if (touchedRef.current.size === 0) {
      // Nothing of the user's is at stake — simply adopt the remote state.
      next = cloneData(serverData);
    } else {
      const merged = mergeRemoteUpdate(baseRef.current, localRef.current, serverData);
      next = merged.data;
      const at = Date.now();
      newResets = merged.resetFields
        .filter((reset) => isTouched(reset.path))
        .map((reset) => ({ ...reset, author, at }));
    }

    baseRef.current = cloneData(serverData);
    localRef.current = next;
    refreshDirty();
    pushToEditor(next);
    if (newResets.length > 0) {
      setResets((prev) => [...prev, ...newResets]);
    }
  };

  // Keep the latest `rebase` for the socket handler without resubscribing.
  const rebaseRef = useRef(rebase);
  rebaseRef.current = rebase;

  const characterId = isDnd5e ? character?.id ?? null : null;

  useEffect(() => {
    if (!socket || !characterId) return;

    const handleCharacterUpdated = (payload: CharacterUpdatedPayload) => {
      if (!payload || payload.characterId !== trackedIdRef.current || !payload.character) return;

      onServerCharacterRef.current?.(payload.character);

      const remoteData = (payload.character.data ?? {}) as CharacterDataObject;
      // Our own save echoed back, or a change outside `data` (name, token).
      if (deepEqual(remoteData, baseRef.current)) return;

      const author: SheetResetAuthor = payload.updatedBy
        ? { userId: payload.updatedBy.userId, displayName: payload.updatedBy.displayName }
        : { ...UNKNOWN_AUTHOR, userId: payload.userId ?? null };
      rebaseRef.current(remoteData, author);
    };

    socket.on(CHARACTER_UPDATED, handleCharacterUpdated);
    return () => {
      socket.off(CHARACTER_UPDATED, handleCharacterUpdated);
    };
  }, [socket, characterId]);

  const reportLocalChange = useCallback(
    (data: CharacterDataObject, origin: LocalChangeOrigin = 'user') => {
      if (!trackedIdRef.current) return;
      const next = cloneData(data);
      if (origin === 'user') {
        for (const path of diffPaths(localRef.current, next)) {
          touchedRef.current.add(path);
        }
      }
      localRef.current = next;
      refreshDirty();
    },
    [],
  );

  const save = useCallback(async (localData: CharacterDataObject): Promise<LiveSaveOutcome> => {
    const id = trackedIdRef.current;
    if (!id) {
      throw new Error('useLiveCharacterSync: no D&D 5e character to save');
    }

    // The data handed to save is the canonical local state (the editor may
    // post-process its form, e.g. theme colour or comma-separated lists).
    const savedLocal = cloneData(localData);
    localRef.current = savedLocal;

    const adoptSaved = (saved: Character): LiveSaveOutcome => {
      const serverData = (saved.data ?? {}) as CharacterDataObject;
      // Keep anything typed while the request was in flight.
      const { data: next } = mergeRemoteUpdate(savedLocal, localRef.current, serverData);
      baseRef.current = cloneData(serverData);
      localRef.current = next;
      refreshDirty();
      pushToEditor(next);
      onServerCharacterRef.current?.(saved);
      return { status: 'saved', character: saved };
    };

    if (needsFullDocumentSave(baseRef.current, savedLocal)) {
      // The data is not path-addressable (the root has a key outside the
      // shared path rules), so field-level changes cannot express it: fall
      // back to the full-document PUT for this save (last write wins).
      const { character: saved } = await api.updateCharacter(id, { data: savedLocal as Character['data'] });
      return adoptSaved(saved);
    }

    const changes = buildChanges(baseRef.current, savedLocal);
    if (changes.length === 0) {
      refreshDirty();
      return { status: 'unchanged' };
    }

    const result = await api.patchCharacterData(id, changes);

    if (result.conflicts.length === 0) {
      return adoptSaved(result.character);
    }

    // Someone changed some of the same fields first: load the current state
    // and merge it — our applied fields match, the conflicting ones reset.
    // Conflict paths/values are not inspected (a path may run through a
    // non-object, `current` may be undefined); the merge works from data.
    const { character: fresh } = await api.getCharacter(id);
    onServerCharacterRef.current?.(fresh);
    rebaseRef.current((fresh.data ?? {}) as CharacterDataObject, UNKNOWN_AUTHOR);
    return { status: 'conflicts', character: fresh, conflicts: result.conflicts };
  }, []);

  const dismissResets = useCallback(() => setResets([]), []);

  return {
    externalData: external.data,
    externalDataVersion: external.version,
    resets,
    dismissResets,
    save,
    reportLocalChange,
    isDirty,
  };
}

export default useLiveCharacterSync;
