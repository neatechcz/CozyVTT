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
  const t3 = new Date('2026-09-26T10:00:02.000Z');

  function row(data: Record<string, unknown>, updatedAt: Date, gameSystem: string | null = 'DND_5E') {
    return { id: 'char-1', userId: 'owner', campaignId: 'camp-1', gameSystem, name: 'Robin', data, updatedAt };
  }

  function makeDeps(opts: {
    reads: unknown[];
    writes?: number[];
    validate?: CharacterPatchDeps['validate'];
  }) {
    const findUnique = jest.fn();
    for (const r of opts.reads) findUnique.mockResolvedValueOnce(r);
    const updateMany = jest.fn();
    for (const count of opts.writes ?? []) updateMany.mockResolvedValueOnce({ count });
    const validate = jest.fn(opts.validate ?? (() => ({ success: true as const, data: {} })));
    const deps = {
      prisma: { character: { findUnique, updateMany } },
      validate,
    } as unknown as CharacterPatchDeps;
    return { deps, findUnique, updateMany, validate };
  }

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

  test('re-reads and re-runs the whole algorithm when the conditional write hits 0 rows', async () => {
    // Between our read and write another writer changed hp.maximum and
    // death saves; the retry must merge on top of that, not overwrite it.
    const first = row({ hp: { current: 3, maximum: 7 } }, t1);
    const second = row({ hp: { current: 3, maximum: 9 } }, t2);
    const saved = row({ hp: { current: 5, maximum: 9 } }, t3);
    const { deps, updateMany } = makeDeps({ reads: [first, second, saved], writes: [0, 1] });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      changes: [{ path: 'hp.current', base: 3, value: 5 }],
    });

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: 'char-1', updatedAt: t1 });
    expect(updateMany.mock.calls[1][0]).toEqual({
      where: { id: 'char-1', updatedAt: t2 },
      data: { data: { hp: { current: 5, maximum: 9 } } },
    });
    expect(result).toMatchObject({ status: 'ok', written: true, applied: ['hp.current'], character: saved });
  });

  test('the retry sees conflicts introduced by the concurrent writer', async () => {
    const first = row({ hp: { current: 3, maximum: 7 } }, t1);
    const second = row({ hp: { current: 1, maximum: 7 } }, t2);
    const { deps, updateMany } = makeDeps({ reads: [first, second], writes: [0] });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      changes: [{ path: 'hp.current', base: 3, value: 5 }],
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'ok',
      written: false,
      character: second,
      applied: [],
      conflicts: [{ path: 'hp.current', base: 3, current: 1, attempted: 5 }],
    });
  });

  test('gives up after 3 attempts and reports every path as a conflict', async () => {
    const reads = [
      row({ hp: { current: 3, maximum: 7 }, notes: 'a' }, t1),
      row({ hp: { current: 3, maximum: 7 }, notes: 'a' }, t2),
      row({ hp: { current: 3, maximum: 7 }, notes: 'a' }, t3),
      row({ hp: { current: 3, maximum: 7 }, notes: 'b' }, new Date('2026-09-26T10:00:03.000Z')),
    ];
    const { deps, updateMany } = makeDeps({ reads, writes: [0, 0, 0] });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      changes: [
        { path: 'hp.current', base: 3, value: 5 },
        { path: 'notes', base: 'a', value: 'c' },
      ],
    });

    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      status: 'ok',
      written: false,
      character: reads[3],
      applied: [],
      conflicts: [
        { path: 'hp.current', base: 3, current: 3, attempted: 5 },
        { path: 'notes', base: 'a', current: 'b', attempted: 'c' },
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

  test('atomic: a conflict introduced by a concurrent writer aborts the retry', async () => {
    const first = row({ hp: { current: 3, maximum: 7 }, notes: 'a' }, t1);
    const second = row({ hp: { current: 2, maximum: 7 }, notes: 'a' }, t2);
    const { deps, updateMany } = makeDeps({ reads: [first, second], writes: [0] });

    const result = await patchCharacterData(deps, {
      id: 'char-1',
      atomic: true,
      changes: [
        { path: 'notes', base: 'a', value: 'b' },
        { path: 'hp.current', base: 3, value: 1 },
      ],
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'ok',
      written: false,
      character: second,
      applied: [],
      conflicts: [{ path: 'hp.current', base: 3, current: 2, attempted: 1 }],
    });
  });

  test('propagates InvalidPathError before touching the database', async () => {
    const { deps, findUnique } = makeDeps({ reads: [] });
    await expect(
      patchCharacterData(deps, {
        id: 'char-1',
        changes: [{ path: 'constructor.prototype', base: undefined, value: 1 }],
      })
    ).rejects.toThrow(InvalidPathError);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
