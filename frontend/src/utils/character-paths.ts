// ============================================
// Character JSON paths
// Frontend copy of the backend `utils/character-paths.ts`. The path
// granularity MUST stay identical on backend, frontend and MCP:
// - a path is the `.`-joined list of object keys;
// - recursion happens only into plain objects;
// - arrays, primitives and `null` are leaves (an array changes as a whole);
// - a key is recursed into only if it matches SAFE_KEY and is not forbidden,
//   otherwise its parent object is treated as a leaf;
// - if the root itself cannot be recursed into, the only path is `""`
//   (the whole document) — such a change cannot be sent as a PATCH;
// - equality is deep structural equality, a missing key equals `undefined`.
// ============================================

const SAFE_KEY = /^[A-Za-z0-9_]+$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSafeSegment(segment: string): boolean {
  return SAFE_KEY.test(segment) && !FORBIDDEN_SEGMENTS.has(segment);
}

/** A plain object whose every key is safe — the only kind of value we recurse into. */
function isRecursable(value: unknown): value is PlainObject {
  return isPlainObject(value) && Object.keys(value).every(isSafeSegment);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Deep structural equality; a missing key equals `undefined`. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const objA = a as PlainObject;
  const objB = b as PlainObject;
  const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);
  for (const key of keys) {
    if (!deepEqual(objA[key], objB[key])) return false;
  }
  return true;
}

/** Same field, or one contains the other; `""` is the whole document. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === '' || b === '' || a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/** True when every segment is a safe key and the path is non-empty. */
export function isSafePath(path: string): boolean {
  if (typeof path !== 'string' || path === '') return false;
  return path.split('.').every(isSafeSegment);
}

function collectDiff(a: unknown, b: unknown, prefix: string, out: string[]): void {
  if (deepEqual(a, b)) return;
  if (!(isRecursable(a) && isRecursable(b))) {
    // A leaf; at the root this is `""` — the whole document.
    out.push(prefix);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    collectDiff(a[key], b[key], prefix === '' ? key : `${prefix}.${key}`, out);
  }
}

/**
 * Paths at which `a` and `b` differ, at the shared granularity.
 * Returns `[""]` when a root cannot be recursed into and the roots differ.
 */
export function diffPaths(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  collectDiff(a, b, '', out);
  return out;
}

export type PathResolution =
  | { kind: 'value'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'blocked'; prefix: string; value: unknown };

/**
 * Resolve `path` against `obj` (same semantics as the backend):
 * - `value`: every segment exists (own keys of plain objects) — its value;
 * - `missing`: a key on the way (or the last one) is absent or `undefined`,
 *   so the path could be created without touching any existing value;
 * - `blocked`: an existing array, `null` or primitive sits at `prefix` before
 *   the end of the path — the path cannot be read or written through it.
 */
export function resolvePath(obj: unknown, path: string): PathResolution {
  const segments = path.split('.');
  let current: unknown = obj;
  for (let i = 0; i < segments.length; i++) {
    if (!isPlainObject(current)) {
      return { kind: 'blocked', prefix: segments.slice(0, i).join('.'), value: current };
    }
    const segment = segments[i];
    if (!hasOwn(current, segment) || current[segment] === undefined) {
      return { kind: 'missing' };
    }
    current = current[segment];
  }
  return { kind: 'value', value: current };
}

/**
 * Reads an own property path; returns `undefined` when any step is missing
 * or blocked. The empty path `""` is the whole document.
 */
export function getAtPath(obj: unknown, path: string): unknown {
  if (path === '') return obj;
  const resolved = resolvePath(obj, path);
  return resolved.kind === 'value' ? resolved.value : undefined;
}

export class PathBlockedError extends Error {
  constructor(public readonly path: string, public readonly prefix: string) {
    super(`Path ${JSON.stringify(path)} is blocked by a non-object value at ${JSON.stringify(prefix)}`);
    this.name = 'PathBlockedError';
  }
}

/**
 * Returns a copy of `obj` with `value` written at `path`; objects along the
 * path are shallow-copied, the input is never mutated. Only missing (or
 * `undefined`) intermediates are created; an existing array, `null` or
 * primitive on the way throws PathBlockedError (like the backend).
 * `undefined` removes the key.
 */
export function setAtPath<T extends PlainObject>(obj: T, path: string, value: unknown): T {
  if (!isSafePath(path)) {
    throw new Error(`Unsafe character data path: ${path}`);
  }
  const segments = path.split('.');
  const root: PlainObject = { ...obj };
  let target = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = hasOwn(target, segment) ? target[segment] : undefined;
    let copy: PlainObject;
    if (next === undefined) {
      copy = {};
    } else if (isPlainObject(next)) {
      copy = { ...next };
    } else {
      throw new PathBlockedError(path, segments.slice(0, i + 1).join('.'));
    }
    target[segment] = copy;
    target = copy;
  }
  const last = segments[segments.length - 1];
  if (value === undefined) {
    delete target[last];
  } else {
    target[last] = value;
  }
  return root as T;
}
