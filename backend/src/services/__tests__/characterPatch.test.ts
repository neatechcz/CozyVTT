/**
 * Character PATCH Service Tests
 * Pure compare-and-set merge plus the conditional-write retry loop, with a
 * fake Prisma client (no database required).
 */

import { z } from 'zod';
import {
  applyCharacterChanges,
  patchCharacterData,
  InvalidPathError,
  TooManyChangesError,
  MAX_CHANGES,
  CharacterPatchDeps,
} from '../characterPatch';

describe('applyCharacterChanges', () => {
  const data = {
    hp: { current: 3, maximum: 7 },
    inventory: [{ name: 'Rope' }],
    name: 'Robin',
  };

  test('applies every change whose base matches', () => {
    const result = applyCharacterChanges(data, [
      { path: 'hp.current', base: 3, value: 5 },
      { path: 'inventory', base: [{ name: 'Rope' }], value: [{ name: 'Rope' }, { name: 'Torch' }] },
    ]);

    expect(result.applied).toEqual(['hp.current', 'inventory']);
    expect(result.conflicts).toEqual([]);
    expect(result.data).toEqual({
      hp: { current: 5, maximum: 7 },
      inventory: [{ name: 'Rope' }, { name: 'Torch' }],
      name: 'Robin',
    });
    // input is never mutated
    expect(data.hp.current).toBe(3);
    expect(data.inventory).toHaveLength(1);
  });

  test('reports a mismatched base as a conflict and applies the rest', () => {
    const result = applyCharacterChanges(data, [
      { path: 'hp.current', base: 4, value: 1 },
      { path: 'hp.maximum', base: 7, value: 9 },
    ]);

    expect(result.applied).toEqual(['hp.maximum']);
    expect(result.conflicts).toEqual([
      { path: 'hp.current', base: 4, current: 3, attempted: 1 },
    ]);
    expect(result.data).toEqual({ ...data, hp: { current: 3, maximum: 9 } });
  });

  test('counts a change as applied when current already equals value', () => {
    const result = applyCharacterChanges(data, [{ path: 'hp.current', base: 1, value: 3 }]);

    expect(result.applied).toEqual(['hp.current']);
    expect(result.conflicts).toEqual([]);
    expect(result.data).toEqual(data);
  });

  test('a missing key matches an undefined base', () => {
    const result = applyCharacterChanges(data, [
      { path: 'hp.temporary', base: undefined, value: 2 },
    ]);

    expect(result.applied).toEqual(['hp.temporary']);
    expect(result.data.hp).toEqual({ current: 3, maximum: 7, temporary: 2 });
  });

  test('compares base deeply', () => {
    const result = applyCharacterChanges(data, [
      { path: 'hp', base: { maximum: 7, current: 3 }, value: { current: 0, maximum: 7 } },
    ]);

    expect(result.applied).toEqual(['hp']);
    expect(result.data.hp).toEqual({ current: 0, maximum: 7 });
  });

  test('a path through an array is a conflict with the blocking value; nothing written', () => {
    const result = applyCharacterChanges(data, [
      { path: 'inventory.0', base: undefined, value: { name: 'Torch' } },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.conflicts).toEqual([
      { path: 'inventory.0', base: undefined, current: [{ name: 'Rope' }], attempted: { name: 'Torch' } },
    ]);
    expect(result.data).toEqual(data);
  });

  test('a path through null is a conflict with current null; nothing written', () => {
    const withNull = { ...data, spellcasting: null };
    const result = applyCharacterChanges(withNull, [
      { path: 'spellcasting.ability', base: undefined, value: 'INT' },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.conflicts).toEqual([
      { path: 'spellcasting.ability', base: undefined, current: null, attempted: 'INT' },
    ]);
    expect(result.data).toEqual(withNull);
  });

  test('throws InvalidPathError for an unsafe path', () => {
    expect(() =>
      applyCharacterChanges(data, [{ path: '__proto__.polluted', base: undefined, value: 1 }])
    ).toThrow(InvalidPathError);
    expect(() =>
      applyCharacterChanges(data, [{ path: 'skills.sleight-of-hand', base: undefined, value: 1 }])
    ).toThrow(InvalidPathError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('throws when given more than the maximum number of changes', () => {
    const changes = Array.from({ length: MAX_CHANGES + 1 }, (_, i) => ({
      path: `k${i}`,
      base: undefined,
      value: i,
    }));
    expect(() => applyCharacterChanges(data, changes)).toThrow(TooManyChangesError);
    expect(() => applyCharacterChanges(data, changes.slice(0, MAX_CHANGES))).not.toThrow();
  });
});

describe('patchCharacterData', () => {
  const t1 = new Date('2026-09-26T10:00:00.000Z');
  const t2 = new Date('2026-09-26T10:00:01.000Z');

  function row(data: Record<string, unknown>, updatedAt: Date, gameSystem: string | null = 'DND_5E') {
    return { id: 'char-1', userId: 'owner', campaignId: 'camp-1', gameSystem, name: 'Robin', data, updatedAt };
  }

  function makeDeps(opts: {
    reads: unknown[];
    writes?: number[];
    validate?: CharacterPatchDeps['validate'];
  }) {
    const order: string[] = [];
    const findUnique = jest.fn(async () => {
      order.push('findUnique');
      return opts.reads.shift() ?? null;
    });
    const writes = [...(opts.writes ?? [])];
    const updateMany = jest.fn(async () => {
      order.push('updateMany');
      return { count: writes.shift() ?? 1 };
    });
    const $queryRaw = jest.fn(async () => {
      order.push('lock');
      return [];
    });
    // Reads and writes exist only on the transaction client: any call on
    // the outer client would throw, proving everything goes through `tx`.
    const tx = { $queryRaw, character: { findUnique, updateMany } };
    const $transaction = jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      order.push('begin');
      const result = await fn(tx);
      order.push('commit');
      return result;
    });
    const validate = jest.fn(opts.validate ?? (() => ({ success: true as const, data: {} })));
    const deps = { prisma: { $transaction }, validate } as unknown as CharacterPatchDeps;
    return { deps, findUnique, updateMany, validate, $transaction, $queryRaw, order };
  }

  test('locks the row inside a transaction, then reads and writes through tx', async () => {
    const saved = row({ hp: { current: 5, maximum: 7 } }, t2);
    const { deps, order, $queryRaw, $transaction } = makeDeps({
      reads: [row({ hp: { current: 3, maximum: 7 } }, t1), saved],
      writes: [1],
    });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      changes: [{ path: 'hp.current', base: 3, value: 5 }],
    });

    expect(result).toMatchObject({ status: 'ok', written: true, character: saved });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['begin', 'lock', 'findUnique', 'updateMany', 'findUnique', 'commit']);
    const [strings, ...values] = $queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('$')).toContain('FOR UPDATE');
    expect(strings.join('$')).toContain('"Character"');
    expect(values).toEqual(['char-1']);
  });

  test('returns not_found when the character does not exist', async () => {
    const { deps, updateMany } = makeDeps({ reads: [null] });
    const result = await patchCharacterData(deps, { id: 'missing', changes: [] });
    expect(result).toEqual({ status: 'not_found' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  test('writes conditionally on the read updatedAt and returns the re-read character', async () => {
    const saved = row({ hp: { current: 5, maximum: 7 } }, t2);
    const { deps, updateMany, findUnique, validate } = makeDeps({
      reads: [row({ hp: { current: 3, maximum: 7 } }, t1), saved],
      writes: [1],
    });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      changes: [{ path: 'hp.current', base: 3, value: 5 }],
    });

    expect(validate).toHaveBeenCalledWith('DND_5E', { hp: { current: 5, maximum: 7 } });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'char-1', updatedAt: t1 },
      data: { data: { hp: { current: 5, maximum: 7 } } },
    });
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      status: 'ok',
      written: true,
      character: saved,
      applied: ['hp.current'],
      conflicts: [],
    });
  });

  test('if the updatedAt guard still hits 0 rows, every change is reported as a conflict', async () => {
    // Unreachable while the row lock is held; defence in depth against a
    // future writer that skips the lock. No retry: the client re-reads.
    const reads = [
      row({ hp: { current: 3, maximum: 7 }, notes: 'a' }, t1),
      row({ hp: { current: 3, maximum: 7 }, notes: 'b' }, t2),
    ];
    const latest = reads[1];
    const { deps, updateMany } = makeDeps({ reads, writes: [0] });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      changes: [
        { path: 'hp.current', base: 3, value: 5 },
        { path: 'notes', base: 'a', value: 'c' },
      ],
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]).toEqual([
      { where: { id: 'char-1', updatedAt: t1 }, data: { data: { hp: { current: 5, maximum: 7 }, notes: 'c' } } },
    ]);
    expect(result).toEqual({
      status: 'ok',
      written: false,
      character: latest,
      applied: [],
      conflicts: [
        { path: 'hp.current', base: 3, current: 3, attempted: 5 },
        { path: 'notes', base: 'a', current: 'b', attempted: 'c' },
      ],
    });
  });

  test('a path blocked by an array is a conflict and nothing is written', async () => {
    const current = row({ inventory: [{ name: 'Rope' }] }, t1);
    const { deps, updateMany } = makeDeps({ reads: [current] });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      changes: [{ path: 'inventory.0', base: undefined, value: { name: 'Torch' } }],
    });

    expect(updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'ok',
      written: false,
      character: current,
      applied: [],
      conflicts: [
        { path: 'inventory.0', base: undefined, current: [{ name: 'Rope' }], attempted: { name: 'Torch' } },
      ],
    });
  });

  test('returns validation errors and writes nothing when the merged data is invalid', async () => {
    const errors = new z.ZodError([
      { code: 'custom', message: 'too low', path: ['hp', 'current'] },
    ]);
    const { deps, updateMany } = makeDeps({
      reads: [row({ hp: { current: 3, maximum: 7 } }, t1)],
      validate: () => ({ success: false, errors }),
    });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      changes: [{ path: 'hp.current', base: 3, value: -100 }],
    });

    expect(result).toEqual({ status: 'invalid', errors });
    expect(updateMany).not.toHaveBeenCalled();
  });

  test('does not write or validate when nothing changes', async () => {
    const current = row({ hp: { current: 5, maximum: 7 } }, t1);
    const { deps, updateMany, validate } = makeDeps({ reads: [current] });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      changes: [
        { path: 'hp.current', base: 3, value: 5 }, // already applied
        { path: 'hp.maximum', base: 6, value: 8 }, // conflict
      ],
    });

    expect(updateMany).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'ok',
      written: false,
      character: current,
      applied: ['hp.current'],
      conflicts: [{ path: 'hp.maximum', base: 6, current: 7, attempted: 8 }],
    });
  });

  test('skips schema validation for characters without a game system', async () => {
    const { deps, validate, updateMany } = makeDeps({
      reads: [row({ notes: 'a' }, t1, null), row({ notes: 'b' }, t2, null)],
      writes: [1],
    });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      changes: [{ path: 'notes', base: 'a', value: 'b' }],
    });

    expect(validate).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'ok', written: true, applied: ['notes'] });
  });

  test('atomic: one conflict means nothing is written and applied is empty', async () => {
    const current = row({ hp: { current: 3, maximum: 7 }, notes: 'a' }, t1);
    const { deps, updateMany, validate } = makeDeps({ reads: [current] });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      atomic: true,
      changes: [
        { path: 'notes', base: 'a', value: 'b' }, // would apply
        { path: 'hp.current', base: 4, value: 1 }, // conflict
      ],
    });

    expect(updateMany).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'ok',
      written: false,
      character: current,
      applied: [],
      conflicts: [{ path: 'hp.current', base: 4, current: 3, attempted: 1 }],
    });
  });

  test('atomic: without conflicts every change is applied and written', async () => {
    const saved = row({ hp: { current: 1, maximum: 7 }, notes: 'b' }, t2);
    const { deps, updateMany } = makeDeps({
      reads: [row({ hp: { current: 3, maximum: 7 }, notes: 'a' }, t1), saved],
      writes: [1],
    });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      atomic: true,
      changes: [
        { path: 'notes', base: 'a', value: 'b' },
        { path: 'hp.current', base: 3, value: 1 },
      ],
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'char-1', updatedAt: t1 },
      data: { data: { hp: { current: 1, maximum: 7 }, notes: 'b' } },
    });
    expect(result).toEqual({
      status: 'ok',
      written: true,
      character: saved,
      applied: ['notes', 'hp.current'],
      conflicts: [],
    });
  });

  test('propagates InvalidPathError before touching the database', async () => {
    const { deps, findUnique, $transaction } = makeDeps({ reads: [] });
    await expect(
      patchCharacterData(deps, {
        id: 'char-1',
        changes: [{ path: 'constructor.prototype', base: undefined, value: 1 }],
      })
    ).rejects.toThrow(InvalidPathError);
    expect(findUnique).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });
});
