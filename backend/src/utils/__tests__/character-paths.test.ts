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
