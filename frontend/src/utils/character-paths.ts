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

/**
 * Reads an own property path; returns `undefined` when any step is missing.
 * The empty path `""` is the whole document.
 */
export function getAtPath(obj: unknown, path: string): unknown {
  if (path === '') return obj;
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Returns a copy of `obj` with `value` written at `path`; objects along the
 * path are shallow-copied (missing or non-object ones are replaced by `{}`),
 * the input is never mutated. `undefined` removes the key.
 */
export function setAtPath<T extends PlainObject>(obj: T, path: string, value: unknown): T {
  if (!isSafePath(path)) {
    throw new Error(`Unsafe character data path: ${path}`);
  }
  const segments = path.split('.');
  const root: PlainObject = { ...obj };
  let target = root;
  let source: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = isPlainObject(source) && hasOwn(source, segment) ? source[segment] : undefined;
    const copy: PlainObject = isPlainObject(next) ? { ...next } : {};
    target[segment] = copy;
    target = copy;
    source = next;
  }
  const last = segments[segments.length - 1];
  if (value === undefined) {
    delete target[last];
  } else {
    target[last] = value;
  }
  return root as T;
}
