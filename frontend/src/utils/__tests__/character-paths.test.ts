import { describe, it, expect } from 'vitest';
import {
  diffPaths,
  getAtPath,
  setAtPath,
  deepEqual,
  isSafePath,
  resolvePath,
  PathBlockedError,
} from '../character-paths';

describe('character-paths', () => {
  describe('diffPaths', () => {
    it('reports only the changed leaf of a nested object', () => {
      expect(
        diffPaths(
          { hp: { current: 3, maximum: 7 } },
          { hp: { current: 5, maximum: 7 } },
        ),
      ).toEqual(['hp.current']);
    });

    it('returns no paths for structurally equal data', () => {
      expect(diffPaths({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } })).toEqual([]);
    });

    it('treats arrays as leaves (a change at an index reports the whole array)', () => {
      const a = { inventory: [{ name: 'Rope' }, { name: 'Torch' }, { name: 'Dagger' }] };
      const b = { inventory: [{ name: 'Rope' }, { name: 'Torch' }, { name: 'Sword' }] };
      expect(diffPaths(a, b)).toEqual(['inventory']);
    });

    it('reports added and removed keys', () => {
      expect(diffPaths({ a: 1, gone: 2 }, { a: 1, added: 3 }).sort()).toEqual(['added', 'gone']);
    });

    it('reports an added nested object by its key, not its children', () => {
      expect(diffPaths({}, { deathSaves: { successes: 0, failures: 0 } })).toEqual(['deathSaves']);
    });

    it('treats a missing key as equal to undefined', () => {
      expect(diffPaths({ a: 1, b: undefined }, { a: 1 })).toEqual([]);
    });

    it('treats null and primitives as leaves', () => {
      expect(diffPaths({ a: null }, { a: { b: 1 } })).toEqual(['a']);
      expect(diffPaths({ a: { b: 1 } }, { a: 5 })).toEqual(['a']);
    });

    it('treats an object with an unsafe key as a leaf (parent path reported)', () => {
      expect(
        diffPaths({ notes: { 'a-b': 1, ok: 1 } }, { notes: { 'a-b': 2, ok: 1 } }),
      ).toEqual(['notes']);
    });

    it('treats an object with a forbidden key as a leaf', () => {
      const a = JSON.parse('{"x":{"constructor":1,"y":1}}');
      const b = JSON.parse('{"x":{"constructor":1,"y":2}}');
      expect(diffPaths(a, b)).toEqual(['x']);
    });

    it('returns [""] (the whole document) when a root cannot be recursed into', () => {
      expect(diffPaths({ 'a-b': 1, ok: 1 }, { 'a-b': 2, ok: 1 })).toEqual(['']);
      expect(diffPaths({ ok: 1 }, { ok: 1, 'bad key': 2 })).toEqual(['']);
      expect(diffPaths(JSON.parse('{"__proto__":1}'), {})).toEqual(['']);
      expect(diffPaths([1], [2])).toEqual(['']);
      expect(diffPaths({ 'a-b': 1 }, { 'a-b': 1 })).toEqual([]);
    });

    it('treats every forbidden segment as unsafe (parent becomes the leaf)', () => {
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        const a = JSON.parse(`{"wrap":{"${key}":1}}`);
        const b = JSON.parse(`{"wrap":{"${key}":2}}`);
        expect(diffPaths(a, b)).toEqual(['wrap']);
      }
    });

    it('recurses into numeric keys such as spell slot levels', () => {
      expect(
        diffPaths(
          { spellcasting: { slots: { 1: { total: 2, expended: 0 } } } },
          { spellcasting: { slots: { 1: { total: 2, expended: 1 } } } },
        ),
      ).toEqual(['spellcasting.slots.1.expended']);
    });
  });

  describe('deepEqual', () => {
    it('compares structurally', () => {
      expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
      expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
      expect(deepEqual([1], { 0: 1 })).toBe(false);
      expect(deepEqual(null, undefined)).toBe(false);
      expect(deepEqual(null, {})).toBe(false);
    });

    it('treats a missing key as undefined', () => {
      expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    });
  });

  describe('getAtPath', () => {
    it('reads nested values and returns undefined for missing or non-object parents', () => {
      const obj = { hp: { current: 4 }, list: [1, 2] };
      expect(getAtPath(obj, 'hp.current')).toBe(4);
      expect(getAtPath(obj, 'hp.missing.deep')).toBeUndefined();
      expect(getAtPath(obj, 'list.length')).toBeUndefined();
    });

    it('reads the whole document for the empty path', () => {
      const obj = { a: 1 };
      expect(getAtPath(obj, '')).toBe(obj);
    });

    it('never reads inherited properties', () => {
      expect(getAtPath({}, 'constructor')).toBeUndefined();
      expect(getAtPath({ a: {} }, 'a.toString')).toBeUndefined();
    });
  });

  describe('resolvePath', () => {
    it('resolves existing values', () => {
      expect(resolvePath({ a: { b: 0 } }, 'a.b')).toEqual({ kind: 'value', value: 0 });
    });

    it('reports missing (or undefined) keys as missing', () => {
      expect(resolvePath({ a: {} }, 'a.b.c')).toEqual({ kind: 'missing' });
      expect(resolvePath({ a: undefined }, 'a.b')).toEqual({ kind: 'missing' });
    });

    it('reports the prefix where an array, null or primitive blocks the path', () => {
      expect(resolvePath({ p: ['light'] }, 'p.weapons')).toEqual({ kind: 'blocked', prefix: 'p', value: ['light'] });
      expect(resolvePath({ p: null }, 'p.weapons')).toEqual({ kind: 'blocked', prefix: 'p', value: null });
      expect(resolvePath({ p: { q: 7 } }, 'p.q.r')).toEqual({ kind: 'blocked', prefix: 'p.q', value: 7 });
    });
  });

  describe('setAtPath', () => {
    it('creates intermediate objects and does not mutate its input', () => {
      const input = { a: { keep: 1 } };
      const snapshot = JSON.parse(JSON.stringify(input));
      const out = setAtPath(input, 'a.b.c', 5);
      expect(out).toEqual({ a: { keep: 1, b: { c: 5 } } });
      expect(input).toEqual(snapshot);
      expect(out).not.toBe(input);
      expect(out.a).not.toBe(input.a);
    });

    it('throws PathBlockedError instead of writing through an array, null or primitive', () => {
      expect(() => setAtPath({ a: 3 }, 'a.b', 1)).toThrow(PathBlockedError);
      expect(() => setAtPath({ a: null }, 'a.b', 1)).toThrow(PathBlockedError);
      expect(() => setAtPath({ a: ['x'] }, 'a.b.c', 1)).toThrow(PathBlockedError);
      try {
        setAtPath({ a: { b: 'str' } }, 'a.b.c', 1);
      } catch (error) {
        expect(error).toBeInstanceOf(PathBlockedError);
        expect((error as PathBlockedError).prefix).toBe('a.b');
      }
    });

    it('creates missing and undefined intermediates', () => {
      expect(setAtPath({ a: undefined }, 'a.b', 1)).toEqual({ a: { b: 1 } });
    });

    it('removes the key when the value is undefined', () => {
      const out = setAtPath({ a: { b: 1, c: 2 } }, 'a.b', undefined);
      expect(out).toEqual({ a: { c: 2 } });
      expect(Object.prototype.hasOwnProperty.call(out.a, 'b')).toBe(false);
    });

    it('refuses unsafe paths', () => {
      expect(() => setAtPath({}, '__proto__.polluted', 1)).toThrow();
      expect(({} as any).polluted).toBeUndefined();
    });
  });

  describe('isSafePath', () => {
    it('accepts dotted identifiers and numeric segments', () => {
      expect(isSafePath('hp.current')).toBe(true);
      expect(isSafePath('spellcasting.slots.1.expended')).toBe(true);
    });

    it('rejects forbidden, malformed and empty paths', () => {
      expect(isSafePath('__proto__.x')).toBe(false);
      expect(isSafePath('a.constructor')).toBe(false);
      expect(isSafePath('prototype')).toBe(false);
      expect(isSafePath('a-b')).toBe(false);
      expect(isSafePath('a..b')).toBe(false);
      expect(isSafePath('')).toBe(false);
    });
  });
});
