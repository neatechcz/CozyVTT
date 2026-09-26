/**
 * Character Path Utility Tests
 * Path granularity shared by the backend PATCH endpoint, the frontend editor
 * and the MCP server: plain objects are recursed, arrays / primitives / null
 * are leaves, and an object with an unsafe key is a leaf as a whole.
 */

import {
  deepEqual,
  diffPaths,
  getAtPath,
  isSafePath,
  isSafeSegment,
  PathBlockedError,
  resolvePath,
  setAtPath,
} from '../character-paths';

describe('character-paths', () => {
  describe('diffPaths', () => {
    test('reports only the changed nested leaf', () => {
      expect(
        diffPaths({ hp: { current: 3, maximum: 7 } }, { hp: { current: 5, maximum: 7 } })
      ).toEqual(['hp.current']);
    });

    test('returns no paths for structurally equal values', () => {
      expect(
        diffPaths(
          { hp: { current: 3 }, inventory: [{ name: 'Rope' }] },
          { inventory: [{ name: 'Rope' }], hp: { current: 3 } }
        )
      ).toEqual([]);
    });

    test('treats arrays as leaves', () => {
      const before = { inventory: [{ name: 'Rope' }, { name: 'Torch' }, { name: 'Dagger' }] };
      const after = { inventory: [{ name: 'Rope' }, { name: 'Torch' }, { name: 'Shortsword' }] };
      expect(diffPaths(before, after)).toEqual(['inventory']);
    });

    test('reports added and removed keys', () => {
      expect(
        diffPaths({ hp: { current: 3 }, notes: 'old' }, { hp: { current: 3, temporary: 2 } }).sort()
      ).toEqual(['hp.temporary', 'notes']);
    });

    test('an unsafe key makes its parent object a leaf', () => {
      expect(
        diffPaths(
          { skills: { 'a-b': 1, stealth: 2 }, hp: { current: 1 } },
          { skills: { 'a-b': 1, stealth: 3 }, hp: { current: 1 } }
        )
      ).toEqual(['skills']);
    });

    test('a forbidden key makes its parent object a leaf', () => {
      const before = JSON.parse('{"meta":{"constructor":1,"x":1}}');
      const after = JSON.parse('{"meta":{"constructor":1,"x":2}}');
      expect(diffPaths(before, after)).toEqual(['meta']);
    });

    test('null and primitives are leaves', () => {
      expect(diffPaths({ spellcasting: null }, { spellcasting: { ability: 'INT' } })).toEqual([
        'spellcasting',
      ]);
      expect(diffPaths({ hp: 3 }, { hp: { current: 3 } })).toEqual(['hp']);
    });

    test('numeric object keys are recursed into', () => {
      expect(
        diffPaths(
          { spellcasting: { slots: { 1: { total: 2, expended: 0 } } } },
          { spellcasting: { slots: { 1: { total: 2, expended: 1 } } } }
        )
      ).toEqual(['spellcasting.slots.1.expended']);
    });

    test('a key explicitly set to undefined equals a missing key', () => {
      expect(diffPaths({ a: 1, b: undefined }, { a: 1 })).toEqual([]);
    });
  });

  describe('deepEqual', () => {
    test('compares structurally', () => {
      expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
      expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
      expect(deepEqual([1, 2], [2, 1])).toBe(false);
      expect(deepEqual(null, undefined)).toBe(false);
      expect(deepEqual(null, null)).toBe(true);
      expect(deepEqual({}, [])).toBe(false);
      expect(deepEqual(1, '1')).toBe(false);
    });

    test('a missing key equals undefined', () => {
      expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
      expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    });
  });

  describe('getAtPath', () => {
    test('reads nested values', () => {
      expect(getAtPath({ hp: { current: 3 } }, 'hp.current')).toBe(3);
      expect(getAtPath({ hp: { current: 3 } }, 'hp')).toEqual({ current: 3 });
    });

    test('returns undefined for missing paths and through leaves', () => {
      expect(getAtPath({ hp: { current: 3 } }, 'hp.temporary')).toBeUndefined();
      expect(getAtPath({ hp: 3 }, 'hp.current')).toBeUndefined();
      expect(getAtPath({ inventory: ['a'] }, 'inventory.0')).toBeUndefined();
      expect(getAtPath({}, 'toString')).toBeUndefined();
    });
  });

  describe('resolvePath', () => {
    test('finds existing values', () => {
      expect(resolvePath({ hp: { current: 3 } }, 'hp.current')).toEqual({ kind: 'value', value: 3 });
      expect(resolvePath({ spellcasting: null }, 'spellcasting')).toEqual({ kind: 'value', value: null });
      expect(resolvePath({ inventory: ['a'] }, 'inventory')).toEqual({ kind: 'value', value: ['a'] });
    });

    test('reports missing keys and missing intermediates as missing', () => {
      expect(resolvePath({ hp: { current: 3 } }, 'hp.temporary')).toEqual({ kind: 'missing' });
      expect(resolvePath({}, 'spellcasting.slots.1.expended')).toEqual({ kind: 'missing' });
      expect(resolvePath({ hp: undefined }, 'hp.current')).toEqual({ kind: 'missing' });
      expect(resolvePath({}, 'toString')).toEqual({ kind: 'missing' });
    });

    test('reports a path that passes through an array, null or primitive as blocked', () => {
      expect(resolvePath({ inventory: ['a', 'b'] }, 'inventory.0')).toEqual({
        kind: 'blocked',
        prefix: 'inventory',
        value: ['a', 'b'],
      });
      expect(resolvePath({ spellcasting: null }, 'spellcasting.ability')).toEqual({
        kind: 'blocked',
        prefix: 'spellcasting',
        value: null,
      });
      expect(resolvePath({ a: { b: 5 } }, 'a.b.c.d')).toEqual({ kind: 'blocked', prefix: 'a.b', value: 5 });
    });
  });

  describe('setAtPath', () => {
    test('sets a nested value without mutating the input', () => {
      const input = { hp: { current: 3, maximum: 7 }, name: 'Robin' };
      const snapshot = JSON.parse(JSON.stringify(input));
      const result = setAtPath(input, 'hp.current', 5);

      expect(result).toEqual({ hp: { current: 5, maximum: 7 }, name: 'Robin' });
      expect(input).toEqual(snapshot);
      expect(result).not.toBe(input);
      expect(result.hp).not.toBe(input.hp);
    });

    test('creates intermediate objects', () => {
      const input: Record<string, unknown> = { name: 'Robin' };
      const result = setAtPath(input, 'spellcasting.slots.1.expended', 1);

      expect(result).toEqual({
        name: 'Robin',
        spellcasting: { slots: { 1: { expended: 1 } } },
      });
      expect(input).toEqual({ name: 'Robin' });
    });

    test('refuses to write into or through arrays, null and primitives', () => {
      const input = { inventory: ['a'], spellcasting: null, hp: 3 };
      expect(() => setAtPath(input, 'inventory.0', 'b')).toThrow(PathBlockedError);
      expect(() => setAtPath(input, 'spellcasting.ability', 'INT')).toThrow(PathBlockedError);
      expect(() => setAtPath(input, 'hp.current', 1)).toThrow(PathBlockedError);
      expect(input).toEqual({ inventory: ['a'], spellcasting: null, hp: 3 });
    });

    test('ignores inherited Object.prototype members when creating intermediates', () => {
      expect(setAtPath({}, 'toString.x', 1)).toEqual({ toString: { x: 1 } });
    });

    test('replaces a whole array leaf', () => {
      const input = { inventory: [{ name: 'Rope' }] };
      const result = setAtPath(input, 'inventory', [{ name: 'Torch' }]);
      expect(result).toEqual({ inventory: [{ name: 'Torch' }] });
      expect(input.inventory).toEqual([{ name: 'Rope' }]);
    });
  });

  describe('isSafePath / isSafeSegment', () => {
    test('accepts dotted word paths', () => {
      expect(isSafePath('hp.current')).toBe(true);
      expect(isSafePath('spellcasting.slots.1.expended')).toBe(true);
      expect(isSafePath('inventory')).toBe(true);
    });

    test('rejects forbidden and malformed paths', () => {
      expect(isSafePath('__proto__.x')).toBe(false);
      expect(isSafePath('a.constructor')).toBe(false);
      expect(isSafePath('prototype')).toBe(false);
      expect(isSafePath('a-b')).toBe(false);
      expect(isSafePath('')).toBe(false);
      expect(isSafePath('a..b')).toBe(false);
      expect(isSafePath('a.')).toBe(false);
      expect(isSafePath(42 as unknown as string)).toBe(false);
    });

    test('isSafeSegment', () => {
      expect(isSafeSegment('current')).toBe(true);
      expect(isSafeSegment('1')).toBe(true);
      expect(isSafeSegment('__proto__')).toBe(false);
      expect(isSafeSegment('a b')).toBe(false);
    });
  });
});
