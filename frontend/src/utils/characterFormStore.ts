// ============================================
// Character form store
// One synchronous store per edited D&D 5e character: the form the user sees,
// the server state it is based on, the fields the user edited and what was
// reset. Every change is a synchronous action applied to the CURRENT state in
// arrival order — keystrokes, remote updates, derived values and save results
// never race through React state batching.
//
// - `edit(path, preEditValue, nextValue)` is compare-and-set: if the form
//   value at `path` is no longer what the user saw when acting (a remote
//   change landed in between), the remote value stays and the user's value is
//   reported as a reset; nothing is dropped silently.
// - Only OWNED paths are ever the user's: paths the user edited (`touched`)
//   and derived values whose inputs the user edited (`derived`). Server
//   updates replace everything else, and a save sends only owned paths — a
//   derived value recalculated on mount never overwrites someone's change.
// - `applyRemote` three-way merges a server update into the owned paths;
//   fields the user edited and someone else changed are reset and reported.
// - `snapshotForSave` / `adoptSaved` bracket a save. While it is in flight,
//   a server value equal to what we sent is our own write (e.g. the echo that
//   arrives before the response), never someone else's change. `base` never
//   moves backwards.
// ============================================

import { deepEqual, diffPaths, getAtPath, pathsOverlap, setAtPath } from './character-paths';
import { cloneData, mergeRemoteUpdate, type CharacterDataObject, type ResetField } from './characterMerge';

export interface SheetResetAuthor {
  userId: string | null;
  displayName: string;
}

export interface SheetReset extends ResetField {
  author: SheetResetAuthor;
  /** When the reset happened (ms since epoch) */
  at: number;
  /** Store version the reset belongs to (dedupe key together with `path`) */
  version?: number;
}

export const UNKNOWN_AUTHOR: SheetResetAuthor = { userId: null, displayName: 'někdo jiný' };
/** Resets caused by the server's answer to the user's own save (normalisation) */
export const SERVER_AUTHOR: SheetResetAuthor = { userId: null, displayName: 'server' };

export interface CharacterFormState {
  /** Last server state the form is based on */
  base: CharacterDataObject;
  /** `updatedAt` of `base` (keeps `base` monotonic) */
  baseUpdatedAt?: string;
  /** What the user sees and edits */
  form: CharacterDataObject;
  /** Paths the user edited that still differ from `base` (or from an in-flight save) */
  touched: ReadonlySet<string>;
  /** Derived paths whose derivation inputs the user edited (saved with the edit) */
  derived: ReadonlySet<string>;
  /** User values that lost to someone else's change, until dismissed */
  resets: SheetReset[];
  /** Bumped by every server state adopted (remote, save, discard) */
  version: number;
}

export interface SaveSnapshot {
  /** Server state the save is based on */
  base: CharacterDataObject;
  /** The whole form at that instant */
  form: CharacterDataObject;
  /** What the server should hold after the save: `base` + the owned paths of `form` */
  sent: CharacterDataObject;
  baseUpdatedAt?: string;
}

export interface CharacterFormStore {
  getState(): CharacterFormState;
  subscribe(listener: () => void): () => void;
  /**
   * Compare-and-set user edit: applies `nextValue` at `path` iff the form
   * still holds `preEditValue` there, otherwise records a reset.
   * Returns true when the edit was applied.
   */
  edit(path: string, preEditValue: unknown, nextValue: unknown): boolean;
  /**
   * User edit of a field as the editor rendered it: `view` is the form the
   * user acted on. A path into an array (`inventory.2.name`) is compared and
   * written as the whole array, the shared path granularity.
   */
  editIn(view: unknown, path: string, value: unknown): boolean;
  /** User edit computed from the current value (e.g. append to an array) */
  editWith(path: string, compute: (current: any) => unknown): void;
  /**
   * Remove the item the user saw at `index` of `renderedArray`: removed from
   * the current array (keeping items others added); if it is not there as
   * rendered any more, the removal loses and is reported.
   */
  removeFromArray(path: string, renderedArray: unknown, index: number): boolean;
  /**
   * Derived values (modifiers, defaults): computed from the current form,
   * never user edits. A changed path is saved only if `inputsOf(path)` names
   * an input the user edited (or a derived value that is saved); otherwise
   * it is display-only and the server value wins.
   */
  derive(
    compute: (form: CharacterDataObject) => CharacterDataObject | null | undefined,
    inputsOf?: (path: string) => string[],
  ): void;
  /** A newer server state from someone else. Returns false if it was older than `base`. */
  applyRemote(serverData: CharacterDataObject, author: SheetResetAuthor, updatedAt?: string): boolean;
  /** Atomic snapshot of what a save sends; marks the save as in flight */
  snapshotForSave(): SaveSnapshot;
  /**
   * The server's answer to the in-flight save; rebases edits typed meanwhile.
   * Returns false (and keeps `base`) when the answer is older than `base`.
   */
  adoptSaved(serverData: CharacterDataObject, updatedAt: string | undefined): boolean;
  /** The in-flight save ended without `adoptSaved` (conflicts, error, nothing to send) */
  endSave(): void;
  /** Forget the user's unsaved edits (cancel, close); resets are kept */
  discard(): void;
  dismissResets(): void;
}

export interface CharacterFormStoreOptions {
  /** Turns server data into the editor's form shape (runs after every server adoption) */
  normalize?: (data: CharacterDataObject) => CharacterDataObject;
  /** `updatedAt` of the initial server data */
  updatedAt?: string;
}

/** True when `a` is a strictly older timestamp than `b` (unparseable → false). */
export function isOlder(a: string | undefined, b: string | undefined): boolean {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  return !Number.isNaN(ta) && !Number.isNaN(tb) && ta < tb;
}

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function isContainer(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object';
}

function segmentsOf(path: string): string[] {
  const segments = path.split('.');
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    throw new Error(`Unsafe form path: ${path}`);
  }
  return segments;
}

/** Reads a form path through objects AND arrays (`inventory.0.name`). `""` = the whole value. */
export function getFormValue(obj: unknown, path: string): unknown {
  if (path === '') return obj;
  let current: unknown = obj;
  for (const segment of segmentsOf(path)) {
    if (!isContainer(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Copy of `root` with `value` at `path` (copy-on-write; arrays stay arrays,
 * a missing or non-object intermediate becomes `{}` — like the editor's
 * `updateField` always did). `undefined` removes the key.
 */
export function setFormValue<T>(root: T, path: string, value: unknown): T {
  const segments = segmentsOf(path);
  const copy = (v: unknown): Record<string, any> =>
    Array.isArray(v) ? [...v] : isContainer(v) ? { ...v } : {};
  const out = copy(root);
  let target = out;
  for (let i = 0; i < segments.length - 1; i++) {
    target[segments[i]] = copy(target[segments[i]]);
    target = target[segments[i]];
  }
  const last = segments[segments.length - 1];
  if (value === undefined) {
    delete target[last];
  } else {
    target[last] = value;
  }
  return out as T;
}

/**
 * The path a user edit is compared and written at: a path into an array
 * stops at that array (arrays are leaves — an index may point at another
 * item by the time the edit lands).
 */
export function editPathFor(view: unknown, path: string): string {
  const segments = segmentsOf(path);
  let current: unknown = view;
  for (let i = 0; i < segments.length - 1; i++) {
    current = isContainer(current) ? current[segments[i]] : undefined;
    if (Array.isArray(current)) return segments.slice(0, i + 1).join('.');
  }
  return path;
}

function isTouched(touched: Iterable<string>, path: string): boolean {
  for (const touchedPath of touched) {
    if (pathsOverlap(touchedPath, path)) return true;
  }
  return false;
}

/** `path` of `value` written into `target` (`""` = the whole document). */
function writePath(target: CharacterDataObject, path: string, value: unknown): CharacterDataObject {
  return path === '' ? (cloneData(value) as CharacterDataObject) : setAtPath(target, path, cloneData(value));
}

/**
 * `from` with the form's values at the owned paths only: the user's side of
 * a merge. Everything the user does not own takes `from`'s value.
 */
function ownedView(from: CharacterDataObject, form: CharacterDataObject, owned: Iterable<string>): CharacterDataObject {
  const ownedPaths = [...owned];
  let out = cloneData(from);
  for (const path of diffPaths(from, form)) {
    if (isTouched(ownedPaths, path)) out = writePath(out, path, getAtPath(form, path));
  }
  return out;
}

interface InFlightSave {
  base: CharacterDataObject;
  sent: CharacterDataObject;
}

export function createCharacterFormStore(
  initialServerData: CharacterDataObject,
  options: CharacterFormStoreOptions = {},
): CharacterFormStore {
  const normalize = options.normalize ?? ((data: CharacterDataObject) => data);
  const initialBase = cloneData(initialServerData ?? {});

  let state: CharacterFormState = {
    base: initialBase,
    baseUpdatedAt: options.updatedAt,
    form: normalize(cloneData(initialBase)),
    touched: new Set(),
    derived: new Set(),
    resets: [],
    version: 0,
  };
  const listeners = new Set<() => void>();
  /** Who last changed each server path (most recent last) — authors of CAS losses */
  const authors = new Map<string, SheetResetAuthor>();
  /** The save whose answer has not been adopted yet */
  let inFlight: InFlightSave | null = null;

  const commit = (next: CharacterFormState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  /**
   * Keep a path while the form differs from `base` there — or from what an
   * in-flight save sent (the user retyped the old value during the save).
   */
  const prune = (paths: ReadonlySet<string>, base: CharacterDataObject, form: CharacterDataObject) => {
    const next = new Set<string>();
    for (const path of paths) {
      const value = getAtPath(form, path);
      if (!deepEqual(getAtPath(base, path), value) || (inFlight && !deepEqual(getAtPath(inFlight.sent, path), value))) {
        next.add(path);
      }
    }
    return next;
  };

  const owned = () => [...state.touched, ...state.derived];

  const rememberAuthors = (
    from: CharacterDataObject,
    to: CharacterDataObject,
    authorOf: (path: string) => SheetResetAuthor,
  ) => {
    for (const path of diffPaths(from, to)) {
      authors.delete(path);
      authors.set(path, authorOf(path));
    }
  };

  const authorFor = (path: string): SheetResetAuthor => {
    let found: SheetResetAuthor | undefined;
    for (const [changed, author] of authors) {
      if (pathsOverlap(changed, path)) found = author;
    }
    return found ?? UNKNOWN_AUTHOR;
  };

  /** Resets are unique per (version, path): a repeat updates `mine`/`theirs`. */
  const withResets = (
    resets: SheetReset[],
    fields: ResetField[],
    version: number,
    authorOf: (path: string) => SheetResetAuthor,
  ): SheetReset[] => {
    if (fields.length === 0) return resets;
    const at = Date.now();
    let next = resets;
    for (const field of fields) {
      const entry: SheetReset = {
        path: field.path,
        mine: cloneData(field.mine),
        theirs: cloneData(field.theirs),
        author: authorOf(field.path),
        at,
        version,
      };
      const index = next.findIndex((reset) => reset.version === version && reset.path === field.path);
      next = index >= 0 ? next.map((reset, i) => (i === index ? { ...entry, at: reset.at } : reset)) : [...next, entry];
    }
    return next;
  };

  /**
   * Move to a new server state: `from` is the state the owned form values
   * are relative to. Untouched paths take the server value; owned paths keep
   * the user's value unless the server changed them too (then the server
   * wins and a touched path is reported).
   */
  const rebase = (
    from: CharacterDataObject,
    server: CharacterDataObject,
    updatedAt: string | undefined,
    authorOf: (path: string) => SheetResetAuthor,
  ) => {
    const { data, resetFields } = mergeRemoteUpdate(from, ownedView(from, state.form, owned()), server);
    const form = normalize(data);
    const version = state.version + 1;
    commit({
      base: server,
      baseUpdatedAt: updatedAt ?? state.baseUpdatedAt,
      form,
      touched: prune(state.touched, server, form),
      derived: prune(state.derived, server, form),
      resets: withResets(
        state.resets,
        resetFields.filter((reset) => isTouched(state.touched, reset.path)),
        version,
        authorOf,
      ),
      version,
    });
  };

  const setUserValue = (path: string, nextValue: unknown) => {
    const form = path === '' ? cloneData(nextValue as CharacterDataObject) : setFormValue(state.form, path, cloneData(nextValue));
    const touched = new Set(state.touched);
    touched.add(path);
    commit({ ...state, form, touched: prune(touched, state.base, form) });
  };

  const edit: CharacterFormStore['edit'] = (path, preEditValue, nextValue) => {
    const current = getFormValue(state.form, path);
    if (!deepEqual(current, preEditValue)) {
      // Someone else's change landed after the user saw the field: it stays.
      if (!deepEqual(current, nextValue)) {
        commit({
          ...state,
          resets: withResets(state.resets, [{ path, mine: nextValue, theirs: current }], state.version, authorFor),
        });
      }
      return false;
    }
    if (!deepEqual(current, nextValue)) setUserValue(path, nextValue);
    return true;
  };

  const endSave = () => {
    if (!inFlight) return;
    inFlight = null;
    const touched = prune(state.touched, state.base, state.form);
    const derived = prune(state.derived, state.base, state.form);
    if (touched.size !== state.touched.size || derived.size !== state.derived.size) {
      commit({ ...state, touched, derived });
    }
  };

  const store: CharacterFormStore = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    edit,

    editIn(view, path, value) {
      const editPath = editPathFor(view, path);
      const pre = getFormValue(view, editPath);
      const next = editPath === path ? value : setFormValue(pre, path.slice(editPath.length + 1), value);
      return edit(editPath, pre, next);
    },

    editWith(path, compute) {
      const current = getFormValue(state.form, path);
      const next = compute(cloneData(current));
      if (!deepEqual(current, next)) setUserValue(path, next);
    },

    removeFromArray(path, renderedArray, index) {
      const rendered = Array.isArray(renderedArray) ? renderedArray : [];
      const current = getFormValue(state.form, path);
      if (Array.isArray(current) && index >= 0 && index < rendered.length) {
        const at = deepEqual(current, rendered)
          ? index
          : current.findIndex((item) => deepEqual(item, rendered[index]));
        if (at >= 0) {
          return edit(path, current, current.filter((_, i) => i !== at));
        }
      }
      // The item is not there as the user saw it: CAS against the rendered
      // array fails and the removal is reported (unless already the outcome).
      return edit(path, rendered, rendered.filter((_, i) => i !== index));
    },

    derive(compute, inputsOf) {
      const next = compute(state.form);
      if (!next || next === state.form || deepEqual(next, state.form)) return;
      const derived = new Set(state.derived);
      const ownedNow = owned();
      for (const path of diffPaths(state.form, next)) {
        if (isTouched(state.touched, path)) continue; // the user's own field stays theirs
        const inputs = inputsOf?.(path) ?? [];
        if (inputs.some((input) => isTouched(ownedNow, input))) derived.add(path);
        else derived.delete(path);
      }
      commit({
        ...state,
        form: next,
        touched: prune(state.touched, state.base, next),
        derived: prune(derived, state.base, next),
      });
    },

    applyRemote(serverData, author, updatedAt) {
      if (isOlder(updatedAt, state.baseUpdatedAt)) return false;
      const server = cloneData(serverData ?? {});
      if (deepEqual(server, state.base)) {
        // Our own save echoed back after its answer, or a change outside `data`.
        state = { ...state, baseUpdatedAt: updatedAt ?? state.baseUpdatedAt };
        return true;
      }
      // While a save is in flight, a server value equal to what we sent is
      // our own write (its echo may come before the answer): relative to it,
      // the user's value is still a local edit, not a conflict.
      let from = state.base;
      if (inFlight) {
        for (const path of diffPaths(inFlight.base, inFlight.sent)) {
          const sent = getAtPath(inFlight.sent, path);
          if (deepEqual(getAtPath(server, path), sent)) from = writePath(from, path, sent);
        }
      }
      rememberAuthors(from, server, () => author);
      rebase(from, server, updatedAt, () => author);
      return true;
    },

    snapshotForSave() {
      const sent = ownedView(state.base, state.form, owned());
      inFlight = { base: cloneData(state.base), sent: cloneData(sent) };
      return { base: cloneData(state.base), form: cloneData(state.form), sent, baseUpdatedAt: state.baseUpdatedAt };
    },

    adoptSaved(serverData, updatedAt) {
      const flight = inFlight;
      if (isOlder(updatedAt, state.baseUpdatedAt)) {
        // A newer server state (written after our save, so it contains it)
        // was adopted while the request was in flight — keep that base.
        endSave();
        return false;
      }
      inFlight = null;
      const sent = flight?.sent ?? state.base;
      const sentPaths = flight ? diffPaths(flight.base, flight.sent) : [];
      // The server changing a value we sent is normalisation of our own
      // write; anything else it answers with is someone else's change.
      const authorOf = (path: string) => (isTouched(sentPaths, path) ? SERVER_AUTHOR : UNKNOWN_AUTHOR);
      const server = cloneData(serverData ?? {});
      rememberAuthors(sent, server, authorOf);
      rebase(sent, server, updatedAt, authorOf);
      return true;
    },

    endSave,

    discard() {
      commit({
        ...state,
        form: normalize(cloneData(state.base)),
        touched: new Set(),
        derived: new Set(),
        version: state.version + 1,
      });
    },

    dismissResets() {
      if (state.resets.length > 0) commit({ ...state, resets: [] });
    },
  };

  return store;
}
