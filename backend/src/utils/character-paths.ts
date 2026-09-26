/**
 * Character Data Paths
 *
 * Field-level addressing of character `data` JSON, shared (by copy) with the
 * frontend editor and the MCP server — the rules must stay identical:
 *
 * - A path is the `.`-joined list of object keys (`hp.current`,
 *   `spellcasting.slots.1.expended`, `inventory`).
 * - Only plain objects are recursed into; arrays, primitives and `null` are
 *   leaves (an array changes as a whole — indexes are not stable identity).
 * - A key is recursed into only if it matches /^[A-Za-z0-9_]+$/ and is not a
 *   forbidden segment; otherwise its parent object is treated as a leaf.
 * - Forbidden segments anywhere: `__proto__`, `constructor`, `prototype`.
 * - Equality is deep structural equality; a missing key equals `undefined`.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9_]+$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isSafeSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment) && !FORBIDDEN_SEGMENTS.has(segment);
}

export function isSafePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  return path.split('.').every(isSafeSegment);
}

/**
 * Deep structural equality for JSON-like values.
 * Object keys whose value is `undefined` are treated as missing.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

/** A plain object whose every key may be recursed into. */
function isRecursable(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).every(isSafeSegment);
}

/**
 * List the paths at which `a` and `b` differ, at the shared path granularity.
 * If the root itself is a leaf (not a recursable plain object) and differs,
 * the result is `['']` — a path no PATCH accepts, so callers must fall back
 * to a whole-document update.
 */
export function diffPaths(a: unknown, b: unknown): string[] {
  const paths: string[] = [];
  collectDiff(a, b, '', paths);
  return paths;
}

function collectDiff(a: unknown, b: unknown, prefix: string, out: string[]): void {
  if (isRecursable(a) && isRecursable(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      collectDiff(a[key], b[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }

  if (!deepEqual(a, b)) {
    out.push(prefix);
  }
}

export type PathResolution =
  | { kind: 'value'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'blocked'; prefix: string; value: unknown };

/**
 * Resolve `path` against `obj`:
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
    if (!Object.prototype.hasOwnProperty.call(current, segment) || current[segment] === undefined) {
      return { kind: 'missing' };
    }
    current = current[segment];
  }

  return { kind: 'value', value: current };
}

/**
 * Read the value at `path`. Only plain objects are traversed (own keys only);
 * traversing through a leaf or a missing key yields `undefined`.
 */
export function getAtPath(obj: unknown, path: string): unknown {
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
 * Return a copy of `obj` with `value` at `path`. Never mutates the input:
 * every object on the path is shallow-copied; untouched branches are shared.
 * Only missing (or `undefined`) intermediates are created; an existing array,
 * `null` or primitive on the way throws PathBlockedError — never written into
 * or through. Callers must check `isSafePath(path)` first.
 */
export function setAtPath<T extends Record<string, unknown>>(obj: T, path: string, value: unknown): T {
  return setIn(obj, path.split('.'), 0, value) as T;
}

function setIn(
  obj: Record<string, unknown>,
  segments: string[],
  index: number,
  value: unknown
): Record<string, unknown> {
  const head = segments[index];
  const copy: Record<string, unknown> = { ...obj };

  if (index === segments.length - 1) {
    copy[head] = value;
    return copy;
  }

  const child = Object.prototype.hasOwnProperty.call(copy, head) ? copy[head] : undefined;
  if (child === undefined) {
    copy[head] = setIn({}, segments, index + 1, value);
  } else if (isPlainObject(child)) {
    copy[head] = setIn(child, segments, index + 1, value);
  } else {
    throw new PathBlockedError(segments.join('.'), segments.slice(0, index + 1).join('.'));
  }
  return copy;
}
