import { describe, it, expect } from 'vitest';
import { mergeRemoteUpdate, buildChanges, diffPaths, needsFullDocumentSave } from '../characterMerge';

const base = () => ({
  characterName: 'Tomin',
  experiencePoints: 100,
  hp: { current: 8, maximum: 10, temporary: 0 },
  currency: { cp: 0, sp: 5, ep: 0, gp: 12, pp: 0 },
  inventory: [{ name: 'Rope' }, { name: 'Torch' }],
  conditions: [] as string[],
  spellcasting: { slots: { 1: { total: 2, expended: 0 }, 2: { total: 1, expended: 0 } } },
});

describe('mergeRemoteUpdate', () => {
  it('takes the remote value for a field untouched locally', () => {
    const b = base();
    const local = base();
    const remote = { ...base(), experiencePoints: 150 };
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data.experiencePoints).toBe(150);
    expect(resetFields).toEqual([]);
  });

  it('keeps the local value for a field changed only locally', () => {
    const b = base();
    const local = { ...base(), characterName: 'Tomin the Bold' };
    const remote = { ...base(), experiencePoints: 150 };
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data.characterName).toBe('Tomin the Bold');
    expect(data.experiencePoints).toBe(150);
    expect(resetFields).toEqual([]);
  });

  it('takes the remote value and records a reset when both changed to different values', () => {
    const b = base();
    const local = { ...base(), hp: { current: 5, maximum: 10, temporary: 0 } };
    const remote = { ...base(), hp: { current: 3, maximum: 10, temporary: 0 } };
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data.hp.current).toBe(3);
    expect(resetFields).toEqual([{ path: 'hp.current', mine: 5, theirs: 3 }]);
  });

  it('records no reset when both changed to the same value', () => {
    const b = base();
    const local = { ...base(), currency: { cp: 0, sp: 5, ep: 0, gp: 20, pp: 0 } };
    const remote = { ...base(), currency: { cp: 0, sp: 5, ep: 0, gp: 20, pp: 0 } };
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data.currency.gp).toBe(20);
    expect(resetFields).toEqual([]);
  });

  it('merges sibling fields of the same nested object independently', () => {
    const b = base();
    const local = { ...base(), hp: { current: 8, maximum: 12, temporary: 0 } };
    const remote = { ...base(), hp: { current: 4, maximum: 10, temporary: 0 } };
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data.hp).toEqual({ current: 4, maximum: 12, temporary: 0 });
    expect(resetFields).toEqual([]);
  });

  it('treats arrays as whole leaves (inventory)', () => {
    const b = base();
    const local = { ...base(), inventory: [{ name: 'Rope' }, { name: 'Torch' }, { name: 'Lute' }] };
    const remote = { ...base(), inventory: [{ name: 'Rope' }] };
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data.inventory).toEqual([{ name: 'Rope' }]);
    expect(resetFields).toEqual([
      {
        path: 'inventory',
        mine: [{ name: 'Rope' }, { name: 'Torch' }, { name: 'Lute' }],
        theirs: [{ name: 'Rope' }],
      },
    ]);
  });

  it('keeps a local array change when the remote left the array alone', () => {
    const b = base();
    const local = { ...base(), conditions: ['poisoned'] };
    const remote = { ...base(), experiencePoints: 999 };
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data.conditions).toEqual(['poisoned']);
    expect(data.experiencePoints).toBe(999);
    expect(resetFields).toEqual([]);
  });

  it('handles deeply nested paths (spellcasting.slots.1.expended)', () => {
    const b = base();
    const local = base();
    local.spellcasting.slots[1].expended = 1;
    local.spellcasting.slots[2].expended = 1;
    const remote = base();
    remote.spellcasting.slots[1].expended = 2;
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data.spellcasting.slots[1].expended).toBe(2);
    expect(data.spellcasting.slots[2].expended).toBe(1);
    expect(resetFields).toEqual([{ path: 'spellcasting.slots.1.expended', mine: 1, theirs: 2 }]);
  });

  it('keeps a key the user added and drops a key the remote removed', () => {
    const b: Record<string, unknown> = { a: 1, b: 2 };
    const local: Record<string, unknown> = { a: 1, b: 2, note: 'hi' };
    const remote: Record<string, unknown> = { a: 1 };
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data).toEqual({ a: 1, note: 'hi' });
    expect(resetFields).toEqual([]);
  });

  it('keeps a local key removal when the remote did not touch it', () => {
    const b: Record<string, unknown> = { a: 1, b: 2 };
    const local: Record<string, unknown> = { a: 1 };
    const remote: Record<string, unknown> = { a: 5, b: 2 };
    const { data } = mergeRemoteUpdate(b, local, remote);
    expect(data).toEqual({ a: 5 });
    expect(Object.prototype.hasOwnProperty.call(data, 'b')).toBe(false);
  });

  it('detects a conflict across granularities (local whole value vs remote nested change)', () => {
    const b: Record<string, unknown> = { x: { a: 1, b: 1 } };
    const local: Record<string, unknown> = { x: ['replaced'] };
    const remote: Record<string, unknown> = { x: { a: 1, b: 2 } };
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data).toEqual({ x: { a: 1, b: 2 } });
    expect(resetFields).toEqual([{ path: 'x', mine: ['replaced'], theirs: { a: 1, b: 2 } }]);
  });

  it('echo of the local state (remote equals local) yields local data and no resets', () => {
    const b = base();
    const local = { ...base(), experiencePoints: 300, conditions: ['prone'] };
    const remote = JSON.parse(JSON.stringify(local));
    const { data, resetFields } = mergeRemoteUpdate(b, local, remote);
    expect(data).toEqual(local);
    expect(resetFields).toEqual([]);
  });

  it('merges a whole-document ("") change when the root is not path-addressable', () => {
    const b: Record<string, unknown> = { 'a-b': 1 };
    const localOnly = mergeRemoteUpdate(b, { 'a-b': 2 }, { 'a-b': 1 });
    expect(localOnly).toEqual({ data: { 'a-b': 2 }, resetFields: [] });

    const both = mergeRemoteUpdate(b, { 'a-b': 2 }, { 'a-b': 3 });
    expect(both).toEqual({
      data: { 'a-b': 3 },
      resetFields: [{ path: '', mine: { 'a-b': 2 }, theirs: { 'a-b': 3 } }],
    });

    const remoteOnly = mergeRemoteUpdate(b, { 'a-b': 1 }, { 'a-b': 4 });
    expect(remoteOnly).toEqual({ data: { 'a-b': 4 }, resetFields: [] });
  });

  it('never mutates its inputs and returns data that shares no objects with them', () => {
    const b = base();
    const local = { ...base(), hp: { current: 5, maximum: 10, temporary: 0 } };
    const remote = { ...base(), experiencePoints: 1 };
    const snapshots = [b, local, remote].map((x) => JSON.parse(JSON.stringify(x)));
    const { data } = mergeRemoteUpdate(b, local, remote);
    expect([b, local, remote]).toEqual(snapshots);
    expect(data.hp).not.toBe(local.hp);
    expect(data.currency).not.toBe(remote.currency);
    data.currency.gp = 777;
    expect(remote.currency.gp).toBe(12);
  });
});

describe('buildChanges', () => {
  it('emits base from base and value from local for every diff path', () => {
    const b = base();
    const local = base();
    local.hp.current = 2;
    local.inventory = [{ name: 'Rope' }];
    local.spellcasting.slots[2].expended = 1;
    const changes = buildChanges(b, local);
    expect(changes.map((c) => c.path).sort()).toEqual(diffPaths(b, local).sort());
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: 'hp.current', base: 8, value: 2 },
        { path: 'inventory', base: [{ name: 'Rope' }, { name: 'Torch' }], value: [{ name: 'Rope' }] },
        { path: 'spellcasting.slots.2.expended', base: 0, value: 1 },
      ]),
    );
    expect(changes).toHaveLength(3);
  });

  it('never emits the whole-document path — callers must use the full PUT instead', () => {
    const b: Record<string, unknown> = { 'a-b': 1 };
    const local: Record<string, unknown> = { 'a-b': 2 };
    expect(needsFullDocumentSave(b, local)).toBe(true);
    expect(() => buildChanges(b, local)).toThrow();
  });

  it('needsFullDocumentSave is false for ordinary field changes', () => {
    const local = base();
    local.hp.current = 1;
    expect(needsFullDocumentSave(base(), local)).toBe(false);
    expect(needsFullDocumentSave(base(), base())).toBe(false);
  });

  it('returns an empty list when nothing changed', () => {
    expect(buildChanges(base(), base())).toEqual([]);
  });

  it('represents added and removed keys with undefined base / value', () => {
    const changes = buildChanges({ a: 1 } as Record<string, unknown>, { b: 2 } as Record<string, unknown>);
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: 'a', base: 1, value: undefined },
        { path: 'b', base: undefined, value: 2 },
      ]),
    );
  });
});
