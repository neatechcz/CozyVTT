// ============================================
// useLiveCharacterSync
// Keeps an open D&D 5e character editor live while someone else (another
// player, the DM or the MCP game master) changes the same character.
//
// The hook owns one synchronous form store per character
// (`createCharacterFormStore`): the editor reads and edits the form through
// it, `character.updated` events are merged into it, and `save()` PATCHes
// only the changed fields of an atomic snapshot. Fields the user edited and
// someone else changed are reset to the new value and collected in `resets`.
// ============================================

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { api, type CharacterDataConflict } from '@/services/api';
import type { Character } from '@/types';
import { buildChanges, needsFullDocumentSave, type CharacterDataObject } from '@/utils/characterMerge';
import {
  createCharacterFormStore,
  isOlder,
  UNKNOWN_AUTHOR,
  type CharacterFormStore,
  type SheetReset,
  type SheetResetAuthor,
} from '@/utils/characterFormStore';

export {
  SERVER_AUTHOR,
  UNKNOWN_AUTHOR,
  type CharacterFormStore,
  type SheetReset,
  type SheetResetAuthor,
} from '@/utils/characterFormStore';

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

/** Shown when a whole-document save was not sent because the sheet changed meanwhile */
export const STALE_SAVE_MESSAGE = 'List mezitím změnil někdo jiný — zkontrolujte změny a uložte znovu.';

export type LiveSaveOutcome =
  | { status: 'saved'; character: Character }
  | { status: 'unchanged' }
  | { status: 'conflicts'; character: Character; conflicts: CharacterDataConflict[] }
  /**
   * A whole-document save was needed but the character changed since the
   * form's base: nothing was written, the newer state was merged into the
   * form (collisions are in `resets`). Show `message` and let the user save again.
   */
  | { status: 'stale'; character: Character; message: string };

export interface UseLiveCharacterSyncOptions {
  character: Character | null;
  socket?: LiveSyncSocket | null;
  isDnd5e: boolean;
  /** Called with every newer server copy of the character (events, saves). */
  onServerCharacter?: (character: Character) => void;
  /** Turns server data into the editor's form shape (e.g. `buildDnd5eFormData`) */
  normalizeForm?: (data: CharacterDataObject) => CharacterDataObject;
}

export interface UseLiveCharacterSyncResult {
  /** The form store the editor reads and edits (null when not live-synced) */
  formStore: CharacterFormStore | null;
  resets: SheetReset[];
  dismissResets: () => void;
  /** Saves the store's current form (the argument is ignored; kept for callers) */
  save: (localData?: unknown) => Promise<LiveSaveOutcome>;
  /** The user has edits that are not on the server */
  isDirty: boolean;
  /**
   * Reloads the character and merges it like a remote update (e.g. after a
   * socket (re)join, to catch changes whose broadcast was missed)
   */
  refresh: () => Promise<void>;
}

const CHARACTER_UPDATED = 'character.updated';

/** Server limit for one PATCH request */
const MAX_PATCH_CHANGES = 200;

const NO_RESETS: SheetReset[] = [];
const noopSubscribe = () => () => {};

export function useLiveCharacterSync({
  character,
  socket,
  isDnd5e,
  onServerCharacter,
  normalizeForm,
}: UseLiveCharacterSyncOptions): UseLiveCharacterSyncResult {
  const trackedIdRef = useRef<string | null>(null);
  const storeRef = useRef<CharacterFormStore | null>(null);
  const onServerCharacterRef = useRef(onServerCharacter);
  onServerCharacterRef.current = onServerCharacter;

  // One store per character id, created synchronously (not in an effect) so
  // the editor can read it in the same render. Another id → a fresh store:
  // nothing of the previous character's state applies.
  if (isDnd5e && character && trackedIdRef.current !== character.id) {
    trackedIdRef.current = character.id;
    storeRef.current = createCharacterFormStore((character.data ?? {}) as CharacterDataObject, {
      normalize: normalizeForm,
      updatedAt: character.updatedAt,
    });
  }
  const store = isDnd5e ? storeRef.current : null;

  const resets = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => (store ? store.getState().resets : NO_RESETS),
  );
  const isDirty = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => (store ? store.getState().touched.size > 0 : false),
  );

  const characterId = store ? trackedIdRef.current : null;

  /** A newer server copy of the tracked character (event or reload) */
  function applyServerCharacter(serverCharacter: Character, author: SheetResetAuthor) {
    const target = storeRef.current;
    if (!target) return;
    // Older than what we already have (e.g. our own save's answer came first)
    if (isOlder(serverCharacter.updatedAt, target.getState().baseUpdatedAt)) return;

    onServerCharacterRef.current?.(serverCharacter);
    target.applyRemote((serverCharacter.data ?? {}) as CharacterDataObject, author, serverCharacter.updatedAt);
  }

  useEffect(() => {
    if (!socket || !characterId) return;

    const handleCharacterUpdated = (payload: CharacterUpdatedPayload) => {
      if (!payload || payload.characterId !== trackedIdRef.current || !payload.character) return;
      const author: SheetResetAuthor = payload.updatedBy
        ? { userId: payload.updatedBy.userId, displayName: payload.updatedBy.displayName }
        : { ...UNKNOWN_AUTHOR, userId: payload.userId ?? null };
      applyServerCharacter(payload.character, author);
    };

    socket.on(CHARACTER_UPDATED, handleCharacterUpdated);
    return () => {
      socket.off(CHARACTER_UPDATED, handleCharacterUpdated);
    };
  }, [socket, characterId]);

  const refresh = useCallback(async (): Promise<void> => {
    const id = trackedIdRef.current;
    if (!id || !storeRef.current) return;
    const { character: fresh } = await api.getCharacter(id);
    if (trackedIdRef.current !== id || fresh.id !== id) return;
    applyServerCharacter(fresh, UNKNOWN_AUTHOR);
  }, []);

  const save = useCallback(async (): Promise<LiveSaveOutcome> => {
    const id = trackedIdRef.current;
    const target = storeRef.current;
    if (!id || !target) {
      throw new Error('useLiveCharacterSync: no D&D 5e character to save');
    }

    // Base and form of one instant: what is sent is exactly the user's
    // fields (and values derived from them) on top of the server state the
    // form is based on. The store treats the save as in flight until
    // adoptSaved/endSave, so its own echo is never mistaken for a remote change.
    const snapshot = target.snapshotForSave();
    const current = () => storeRef.current === target;

    const adoptSaved = (saved: Character): LiveSaveOutcome => {
      const adopted = current() && target.adoptSaved((saved.data ?? {}) as CharacterDataObject, saved.updatedAt);
      // An answer older than an already adopted broadcast is not news.
      if (adopted) onServerCharacterRef.current?.(saved);
      return { status: 'saved', character: saved };
    };

    /** Adopts a newer server copy through the normal remote merge. */
    const mergeFresh = (fresh: Character) => {
      if (current() && target.applyRemote((fresh.data ?? {}) as CharacterDataObject, UNKNOWN_AUTHOR, fresh.updatedAt)) {
        onServerCharacterRef.current?.(fresh);
      }
    };

    /** Not written: the character changed since the form's base — merge it, ask to save again. */
    const stale = (latest: Character): LiveSaveOutcome => {
      mergeFresh(latest);
      target.endSave();
      return { status: 'stale', character: latest, message: STALE_SAVE_MESSAGE };
    };

    // The PUT replaces the whole document, so it may only be sent while the
    // form's base is still the server state: otherwise it would write back
    // the old values of fields someone else changed meanwhile. The re-read
    // catches most of that without a write; the PUT's server-side
    // precondition (`expectedUpdatedAt`, checked under the row lock) closes
    // the window between the re-read and the PUT — its 409 is the same stale case.
    const saveWholeDocument = async (): Promise<LiveSaveOutcome> => {
      const { character: latest } = await api.getCharacter(id);
      if (!snapshot.baseUpdatedAt || latest.updatedAt !== snapshot.baseUpdatedAt) {
        return stale(latest);
      }
      const result = await api.updateCharacterIfUnchanged(
        id,
        { data: snapshot.sent as Character['data'] },
        snapshot.baseUpdatedAt,
      );
      if (result.status === 409) return stale(result.character);
      return adoptSaved(result.character);
    };

    try {
      if (needsFullDocumentSave(snapshot.base, snapshot.sent)) {
        // The data is not path-addressable (the root has a key outside the
        // shared path rules), so field-level changes cannot express it: fall
        // back to the full-document PUT (only while the base is current).
        return await saveWholeDocument();
      }

      const changes = buildChanges(snapshot.base, snapshot.sent);
      if (changes.length === 0) {
        target.endSave();
        return { status: 'unchanged' };
      }
      if (changes.length > MAX_PATCH_CHANGES) {
        // The PATCH endpoint rejects more than 200 changes: use the full PUT.
        return await saveWholeDocument();
      }

      const result = await api.patchCharacterData(id, changes);

      if (result.conflicts.length === 0) {
        return adoptSaved(result.character);
      }

      // Someone changed some of the same fields first: load the current state
      // and merge it — our applied fields match what we sent (so they are our
      // own write, not someone else's), the conflicting ones reset.
      // Conflict paths/values are not inspected (a path may run through a
      // non-object, `current` may be undefined); the merge works from data.
      const { character: fresh } = await api.getCharacter(id);
      mergeFresh(fresh);
      target.endSave();
      return { status: 'conflicts', character: fresh, conflicts: result.conflicts };
    } catch (error) {
      target.endSave();
      throw error;
    }
  }, []);

  const dismissResets = useCallback(() => storeRef.current?.dismissResets(), []);

  return {
    formStore: store,
    resets,
    dismissResets,
    save,
    isDirty,
    refresh,
  };
}

export default useLiveCharacterSync;
