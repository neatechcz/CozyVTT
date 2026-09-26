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
import { deepEqual, diffPaths, getAtPath, pathsOverlap } from '@/utils/character-paths';

export interface SheetResetAuthor {
  userId: string | null;
  displayName: string;
}

export interface SheetReset extends ResetField {
  author: SheetResetAuthor;
  /** When the reset happened (ms since epoch) */
  at: number;
  /** The external push version that caused it (dedupe key with `path`) */
  version?: number;
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
  /**
   * The local data `externalData` was merged against. The editor rebases its
   * current form onto `externalData` relative to this, so edits it has not
   * reported yet survive the update.
   */
  externalBase: CharacterDataObject | undefined;
  externalDataVersion: number;
  resets: SheetReset[];
  dismissResets: () => void;
  save: (localData: CharacterDataObject) => Promise<LiveSaveOutcome>;
  /**
   * The editor reports every form change. `rebaseResets` are fields its own
   * rebase onto `externalData` reset (unreported user edits that lost);
   * `appliedVersion` is the external version the reported form includes.
   */
  reportLocalChange: (
    data: CharacterDataObject,
    origin?: LocalChangeOrigin,
    rebaseResets?: ResetField[],
    appliedVersion?: number,
    /** Fields the user edited since the last user report (editor-provided) */
    userPaths?: string[],
  ) => void;
  /** Forget the user's unsaved edits (editor cancelled or closed); keeps resets */
  discardLocalChanges: () => void;
  /** The user has edits that are not on the server */
  isDirty: boolean;
}

export const UNKNOWN_AUTHOR: SheetResetAuthor = { userId: null, displayName: 'někdo jiný' };
/** Resets caused by the server's answer to the user's own save (normalisation) */
export const SERVER_AUTHOR: SheetResetAuthor = { userId: null, displayName: 'server' };

const CHARACTER_UPDATED = 'character.updated';

/** Server limit for one PATCH request */
const MAX_PATCH_CHANGES = 200;

/** True when `a` is a strictly older timestamp than `b` (unparseable → false). */
function isOlder(a: string | undefined, b: string | undefined): boolean {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  return !Number.isNaN(ta) && !Number.isNaN(tb) && ta < tb;
}

interface ExternalState {
  data: CharacterDataObject | undefined;
  base: CharacterDataObject | undefined;
  version: number;
  /** Whose change the push carries (for resets the editor finds applying it) */
  author: SheetResetAuthor;
}

const INITIAL_EXTERNAL: ExternalState = { data: undefined, base: undefined, version: 0, author: UNKNOWN_AUTHOR };

export function useLiveCharacterSync({
  character,
  socket,
  isDnd5e,
  onServerCharacter,
}: UseLiveCharacterSyncOptions): UseLiveCharacterSyncResult {
  const [external, setExternal] = useState<ExternalState>(INITIAL_EXTERNAL);
  /** Synchronous mirror of `external` (reports can arrive before it renders) */
  const externalRef = useRef<ExternalState>(INITIAL_EXTERNAL);
  /** Author of each push, by version */
  const pushAuthorsRef = useRef<Map<number, SheetResetAuthor>>(new Map());
  /** `${version}:${path}` of every reset recorded, so no reset is listed twice */
  const recordedResetKeysRef = useRef<Set<string>>(new Set());
  const [resets, setResets] = useState<SheetReset[]>([]);
  const [isDirty, setIsDirty] = useState(false);

  const trackedIdRef = useRef<string | null>(null);
  const baseRef = useRef<CharacterDataObject>({});
  /** `updatedAt` of the server state in `baseRef` */
  const baseUpdatedAtRef = useRef<string | undefined>(undefined);
  const localRef = useRef<CharacterDataObject>({});
  /** The editor's form data exactly as last reported (before save post-processing) */
  const lastReportedRef = useRef<CharacterDataObject>({});
  /** Paths the user edited that still differ from `base` */
  const touchedRef = useRef<Set<string>>(new Set());
  const onServerCharacterRef = useRef(onServerCharacter);
  onServerCharacterRef.current = onServerCharacter;

  // Adopt the character synchronously (not in an effect): the editor is a
  // child, and child effects — including its first local report — run before
  // ours, so `base` must already be set when that report arrives.
  if (isDnd5e && character && trackedIdRef.current !== character.id) {
    const switching = trackedIdRef.current !== null;
    trackedIdRef.current = character.id;
    baseRef.current = cloneData((character.data ?? {}) as CharacterDataObject);
    baseUpdatedAtRef.current = character.updatedAt;
    localRef.current = cloneData(baseRef.current);
    lastReportedRef.current = cloneData(baseRef.current);
    touchedRef.current = new Set();
    externalRef.current = INITIAL_EXTERNAL;
    pushAuthorsRef.current = new Map();
    recordedResetKeysRef.current = new Set();
    if (switching) {
      // Another character: nothing of the previous one's state applies.
      setExternal(INITIAL_EXTERNAL);
      setResets([]);
      setIsDirty(false);
    }
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

  /**
   * Hand `data` to the editor together with the form data it last reported:
   * the editor rebases its current form onto `data` relative to that, so
   * only edits it has not reported yet are kept on top.
   */
  const pushToEditor = (data: CharacterDataObject, author: SheetResetAuthor) => {
    const push: ExternalState = {
      data: cloneData(data),
      base: cloneData(lastReportedRef.current),
      version: externalRef.current.version + 1,
      author,
    };
    externalRef.current = push;
    pushAuthorsRef.current.set(push.version, author);
    setExternal(push);
  };

  /**
   * Record resets, one entry per (push version, path): a repeat for the same
   * push (e.g. a later stale keystroke on the same field) updates that entry's
   * `mine` to the latest value instead of adding another.
   */
  const recordResets = (resetFields: ResetField[], version: number, author: SheetResetAuthor) => {
    if (resetFields.length === 0) return;
    const at = Date.now();
    const fresh: SheetReset[] = [];
    const updates: ResetField[] = [];
    for (const reset of resetFields) {
      const key = `${version}:${reset.path}`;
      if (recordedResetKeysRef.current.has(key)) {
        updates.push(reset);
        continue;
      }
      recordedResetKeysRef.current.add(key);
      fresh.push({ ...reset, author, at, version });
    }
    setResets((prev) => {
      let next = prev;
      if (updates.length > 0) {
        next = prev.map((entry) => {
          if (entry.version !== version) return entry;
          const update = updates.find((reset) => reset.path === entry.path);
          return update && !deepEqual(update.mine, entry.mine) ? { ...entry, mine: update.mine } : entry;
        });
      }
      return fresh.length > 0 ? [...next, ...fresh] : next;
    });
  };

  /** Move `base` to a new server state, merging it into the local data. */
  const rebase = (serverData: CharacterDataObject, author: SheetResetAuthor, updatedAt?: string) => {
    let next: CharacterDataObject;
    let newResets: ResetField[] = [];

    if (touchedRef.current.size === 0) {
      // Nothing of the user's is at stake — simply adopt the remote state.
      next = cloneData(serverData);
    } else {
      const merged = mergeRemoteUpdate(baseRef.current, localRef.current, serverData);
      next = merged.data;
      newResets = merged.resetFields.filter((reset) => isTouched(reset.path));
    }

    baseRef.current = cloneData(serverData);
    baseUpdatedAtRef.current = updatedAt;
    localRef.current = next;
    refreshDirty();
    pushToEditor(next, author);
    recordResets(newResets, externalRef.current.version, author);
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
      if (deepEqual(remoteData, baseRef.current)) {
        if (!isOlder(payload.character.updatedAt, baseUpdatedAtRef.current)) {
          baseUpdatedAtRef.current = payload.character.updatedAt;
        }
        return;
      }

      const author: SheetResetAuthor = payload.updatedBy
        ? { userId: payload.updatedBy.userId, displayName: payload.updatedBy.displayName }
        : { ...UNKNOWN_AUTHOR, userId: payload.userId ?? null };
      rebaseRef.current(remoteData, author, payload.character.updatedAt);
    };

    socket.on(CHARACTER_UPDATED, handleCharacterUpdated);
    return () => {
      socket.off(CHARACTER_UPDATED, handleCharacterUpdated);
    };
  }, [socket, characterId]);

  const reportLocalChange = useCallback(
    (
      data: CharacterDataObject,
      origin: LocalChangeOrigin = 'user',
      rebaseResets?: ResetField[],
      appliedVersion?: number,
      userPaths?: string[],
    ) => {
      if (!trackedIdRef.current) return;
      const next = cloneData(data);
      const push = externalRef.current;
      /** Changed paths that are the user's: when the editor names the fields it
       * edited, derived/system changes in the same report are not the user's. */
      const markUserPaths = (changed: string[]) => {
        if (origin !== 'user') return;
        for (const path of changed) {
          if (userPaths && !userPaths.some((userPath) => pathsOverlap(userPath, path))) continue;
          touchedRef.current.add(path);
        }
      };

      if (appliedVersion !== undefined && appliedVersion < push.version && push.data && push.base) {
        // Stale report: the form does not include the latest push yet, so it
        // must not be diffed against `local` (a state the editor never had).
        // The user's edits are what changed since the last report; merge the
        // form onto the pending push exactly as the editor will when it
        // applies it — and surface what that merge resets.
        markUserPaths(diffPaths(lastReportedRef.current, next));
        const merged = mergeRemoteUpdate(push.base, next, push.data);
        recordResets(
          merged.resetFields.filter((reset) => isTouched(reset.path)),
          push.version,
          push.author,
        );
        localRef.current = merged.data;
      } else {
        markUserPaths(diffPaths(localRef.current, next));
        localRef.current = next;
      }
      lastReportedRef.current = next;

      if (rebaseResets && rebaseResets.length > 0) {
        const version = appliedVersion ?? push.version;
        recordResets(rebaseResets, version, pushAuthorsRef.current.get(version) ?? UNKNOWN_AUTHOR);
      }
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
      if (isOlder(saved.updatedAt, baseUpdatedAtRef.current)) {
        // A newer broadcast (written after our save, so it already contains
        // it) was adopted while the request was in flight — keep that base.
        refreshDirty();
        return { status: 'saved', character: saved };
      }
      const serverData = (saved.data ?? {}) as CharacterDataObject;
      // Keep anything typed while the request was in flight.
      const { data: next } = mergeRemoteUpdate(savedLocal, localRef.current, serverData);
      baseRef.current = cloneData(serverData);
      baseUpdatedAtRef.current = saved.updatedAt;
      localRef.current = next;
      refreshDirty();
      pushToEditor(next, SERVER_AUTHOR);
      onServerCharacterRef.current?.(saved);
      return { status: 'saved', character: saved };
    };

    const saveWholeDocument = async (): Promise<LiveSaveOutcome> => {
      const { character: saved } = await api.updateCharacter(id, { data: savedLocal as Character['data'] });
      return adoptSaved(saved);
    };

    if (needsFullDocumentSave(baseRef.current, savedLocal)) {
      // The data is not path-addressable (the root has a key outside the
      // shared path rules), so field-level changes cannot express it: fall
      // back to the full-document PUT for this save (last write wins).
      return saveWholeDocument();
    }

    const changes = buildChanges(baseRef.current, savedLocal);
    if (changes.length === 0) {
      refreshDirty();
      return { status: 'unchanged' };
    }
    if (changes.length > MAX_PATCH_CHANGES) {
      // The PATCH endpoint rejects more than 200 changes (e.g. a first save
      // of an old sheet the editor normalised heavily): use the full PUT.
      return saveWholeDocument();
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
    rebaseRef.current((fresh.data ?? {}) as CharacterDataObject, UNKNOWN_AUTHOR, fresh.updatedAt);
    return { status: 'conflicts', character: fresh, conflicts: result.conflicts };
  }, []);

  const dismissResets = useCallback(() => setResets([]), []);

  const discardLocalChanges = useCallback(() => {
    if (!trackedIdRef.current) return;
    localRef.current = cloneData(baseRef.current);
    lastReportedRef.current = cloneData(baseRef.current);
    touchedRef.current = new Set();
    setIsDirty(false);
  }, []);

  return {
    externalData: external.data,
    externalBase: external.base,
    externalDataVersion: external.version,
    resets,
    dismissResets,
    save,
    reportLocalChange,
    discardLocalChanges,
    isDirty,
  };
}

export default useLiveCharacterSync;
