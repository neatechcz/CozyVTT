import { describe, it, expect, vi } from 'vitest';
import { diffPaths, getAtPath } from '../character-paths';
import {
  createCharacterFormStore,
  editPathFor,
  getFormValue,
  isOlder,
  setFormValue,
  SERVER_AUTHOR,
  UNKNOWN_AUTHOR,
} from '../characterFormStore';

const gm = { userId: 'gm', displayName: 'GM' };

const server = () => ({
  characterName: 'Tomin',
  experiencePoints: 100,
  hp: { current: 8, maximum: 10, temporary: 0 },
  stats: { strength: { score: 15, modifier: 2 } },
  inventory: [{ name: 'Rope' }, { name: 'Lute' }, { name: 'Torch' }],
  conditions: [] as string[],
});

const T0 = '2026-09-26T00:00:00.000Z';
const T1 = '2026-09-26T00:00:01.000Z';
const T2 = '2026-09-26T00:00:02.000Z';

function setup(options: Parameters<typeof createCharacterFormStore>[1] = { updatedAt: T0 }) {
  const store = createCharacterFormStore(server(), options);
  const listener = vi.fn();
  store.subscribe(listener);
  return { store, listener, form: () => store.getState().form as any };
}

describe('form path helpers', () => {
  it('getFormValue reads through objects and arrays', () => {
    expect(getFormValue(server(), 'inventory.1.name')).toBe('Lute');
    expect(getFormValue(server(), 'hp.current')).toBe(8);
    expect(getFormValue(server(), 'hp.nope.deeper')).toBeUndefined();
    expect(getFormValue(server(), '')).toEqual(server());
  });

  it('setFormValue copies on write and keeps arrays arrays', () => {
    const data = server();
    const next = setFormValue(data, 'inventory.1.name', 'Harp');
    expect(Array.isArray(next.inventory)).toBe(true);
    expect(next.inventory[1]).toEqual({ name: 'Harp' });
    expect(data.inventory[1]).toEqual({ name: 'Lute' });
    expect(next.inventory[0]).toBe(data.inventory[0]);
    expect(setFormValue({}, 'a.b', 1)).toEqual({ a: { b: 1 } });
    expect(() => setFormValue({}, '__proto__.x', 1)).toThrow();
  });

  it('editPathFor stops a path into an array at the array', () => {
    expect(editPathFor(server(), 'inventory.1.name')).toBe('inventory');
    expect(editPathFor(server(), 'hp.current')).toBe('hp.current');
    expect(editPathFor(server(), 'spellcasting.slots.1.total')).toBe('spellcasting.slots.1.total');
  });

  it('isOlder compares timestamps, unparseable is never older', () => {
    expect(isOlder(T0, T1)).toBe(true);
    expect(isOlder(T1, T1)).toBe(false);
    expect(isOlder(undefined, T1)).toBe(false);
  });
});

describe('createCharacterFormStore', () => {
  it('starts with base = form = server data (normalized), nothing touched', () => {
    const { store } = setup({ normalize: (d) => ({ ...d, deathSaves: { successes: 0 } }) });
    const state = store.getState();
    expect(state.base).toEqual(server());
    expect(state.form).toEqual({ ...server(), deathSaves: { successes: 0 } });
    expect(state.touched.size).toBe(0);
    expect(state.resets).toEqual([]);
    expect(state.version).toBe(0);
  });

  it('edit applies when the form still holds the pre-edit value, marks it touched and notifies', () => {
    const { store, listener, form } = setup();
    expect(store.edit('experiencePoints', 100, 120)).toBe(true);
    expect(form().experiencePoints).toBe(120);
    expect([...store.getState().touched]).toEqual(['experiencePoints']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('edit back to the server value is not dirty any more', () => {
    const { store } = setup();
    store.edit('experiencePoints', 100, 120);
    store.edit('experiencePoints', 120, 100);
    expect(store.getState().touched.size).toBe(0);
  });

  it('CAS: an edit whose pre-edit value is stale keeps the remote value and records a reset', () => {
    const { store, form } = setup();
    store.applyRemote({ ...server(), experiencePoints: 150 }, gm, T1);
    // The user acted on the form still showing 100.
    expect(store.edit('experiencePoints', 100, 120)).toBe(false);
    expect(form().experiencePoints).toBe(150);
    expect(store.getState().touched.size).toBe(0);
    expect(store.getState().resets).toEqual([
      expect.objectContaining({ path: 'experiencePoints', mine: 120, theirs: 150, author: gm }),
    ]);
  });

  it('CAS: a stale edit that equals the current value loses nothing and records nothing', () => {
    const { store } = setup();
    store.applyRemote({ ...server(), experiencePoints: 150 }, gm, T1);
    expect(store.edit('experiencePoints', 100, 150)).toBe(false);
    expect(store.getState().resets).toEqual([]);
  });

  it('CAS: repeated stale edits of the same field update one reset entry', () => {
    const { store } = setup();
    store.applyRemote({ ...server(), experiencePoints: 150 }, gm, T1);
    store.edit('experiencePoints', 100, 12);
    store.edit('experiencePoints', 100, 120);
    expect(store.getState().resets).toEqual([expect.objectContaining({ path: 'experiencePoints', mine: 120 })]);
  });

  it('CAS reset whose author is unknown falls back to "někdo jiný"', () => {
    const { store } = setup();
    expect(store.edit('experiencePoints', 99, 120)).toBe(false);
    expect(store.getState().resets[0].author).toEqual(UNKNOWN_AUTHOR);
  });

  it('editIn compares and writes a path into an array as the whole array', () => {
    const { store, form } = setup();
    const view = form();
    expect(store.editIn(view, 'inventory.1.name', 'Harp')).toBe(true);
    expect(form().inventory).toEqual([{ name: 'Rope' }, { name: 'Harp' }, { name: 'Torch' }]);
    expect([...store.getState().touched]).toEqual(['inventory']);

    // Someone inserted an item at the front; the stale index would hit Rope.
    const stale = form();
    store.applyRemote({ ...server(), inventory: [{ name: 'Gem' }, ...server().inventory] }, gm, T1);
    expect(store.editIn(stale, 'inventory.1.name', 'Harpsichord')).toBe(false);
    expect(form().inventory.map((i: any) => i.name)).toEqual(['Gem', 'Rope', 'Lute', 'Torch']);
    expect(store.getState().resets.map((r) => r.path)).toContain('inventory');
  });

  it('editWith computes from the current value (an append keeps a remote append)', () => {
    const { store, form } = setup();
    store.applyRemote({ ...server(), inventory: [...server().inventory, { name: 'Gem' }] }, gm, T1);
    store.editWith('inventory', (current) => [...current, { name: 'Sword' }]);
    expect(form().inventory.map((i: any) => i.name)).toEqual(['Rope', 'Lute', 'Torch', 'Gem', 'Sword']);
    expect(store.getState().touched.has('inventory')).toBe(true);
  });

  it('removeFromArray removes the rendered item from the current array (remote additions survive)', () => {
    const { store, form } = setup();
    const rendered = form().inventory;
    store.applyRemote({ ...server(), inventory: [{ name: 'Gem' }, ...server().inventory] }, gm, T1);
    expect(store.removeFromArray('inventory', rendered, 1)).toBe(true); // Lute, as the user saw it
    expect(form().inventory.map((i: any) => i.name)).toEqual(['Gem', 'Rope', 'Torch']);
    expect(store.getState().resets).toEqual([]);
  });

  it('removeFromArray of an item someone changed meanwhile loses and is reported', () => {
    const { store, form } = setup();
    const rendered = form().inventory;
    const changed = [{ name: 'Rope' }, { name: 'Lute', quantity: 2 }, { name: 'Torch' }];
    store.applyRemote({ ...server(), inventory: changed }, gm, T1);
    expect(store.removeFromArray('inventory', rendered, 1)).toBe(false);
    expect(form().inventory).toEqual(changed);
    expect(store.getState().resets).toEqual([
      expect.objectContaining({ path: 'inventory', mine: [{ name: 'Rope' }, { name: 'Torch' }], theirs: changed, author: gm }),
    ]);
  });

  it('derive changes the form without touching it', () => {
    const { store, form, listener } = setup();
    store.derive((f) => ({ ...f, stats: { strength: { score: 15, modifier: 3 } } }));
    expect(form().stats.strength.modifier).toBe(3);
    expect(store.getState().touched.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    store.derive(() => null);
    store.derive((f) => ({ ...f }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe('applyRemote (three-way merge table)', () => {
    it('untouched locally → remote value', () => {
      const { store, form } = setup();
      store.applyRemote({ ...server(), experiencePoints: 150 }, gm, T1);
      expect(form().experiencePoints).toBe(150);
      expect(store.getState().base.experiencePoints).toBe(150);
      expect(store.getState().version).toBe(1);
      expect(store.getState().resets).toEqual([]);
    });

    it('changed locally only → local value stays, still dirty', () => {
      const { store, form } = setup();
      store.edit('characterName', 'Tomin', 'Tomin the Bold');
      store.applyRemote({ ...server(), experiencePoints: 150 }, gm, T1);
      expect(form().characterName).toBe('Tomin the Bold');
      expect(form().experiencePoints).toBe(150);
      expect(store.getState().touched.has('characterName')).toBe(true);
    });

    it('changed by both to different values → remote value + reset with the author', () => {
      const { store, form } = setup();
      store.edit('hp.current', 8, 5);
      store.applyRemote({ ...server(), hp: { current: 3, maximum: 10, temporary: 0 } }, gm, T1);
      expect(form().hp.current).toBe(3);
      expect(store.getState().resets).toEqual([
        expect.objectContaining({ path: 'hp.current', mine: 5, theirs: 3, author: gm, version: 1 }),
      ]);
      expect(store.getState().touched.size).toBe(0);
    });

    it('changed by both to the same value → no reset', () => {
      const { store } = setup();
      store.edit('hp.current', 8, 3);
      store.applyRemote({ ...server(), hp: { current: 3, maximum: 10, temporary: 0 } }, gm, T1);
      expect(store.getState().resets).toEqual([]);
      expect(store.getState().touched.size).toBe(0);
    });

    it('derived or normalized differences never produce resets; the remote wins', () => {
      const { store, form } = setup({ updatedAt: T0, normalize: (d) => ({ deathSaves: { successes: 0, failures: 0 }, ...d }) });
      store.derive((f) => ({ ...f, stats: { strength: { score: 15, modifier: 9 } } }));
      store.applyRemote(
        { ...server(), deathSaves: { successes: 1, failures: 0 }, stats: { strength: { score: 15, modifier: 4 } } },
        gm,
        T1,
      );
      expect(form().deathSaves).toEqual({ successes: 1, failures: 0 });
      expect(form().stats.strength.modifier).toBe(4);
      expect(store.getState().resets).toEqual([]);
    });

    it('arrays are leaves: a local and a remote inventory change conflict as a whole', () => {
      const { store, form } = setup();
      store.editWith('inventory', (items) => items.slice(1));
      const remote = [...server().inventory, { name: 'Gem' }];
      store.applyRemote({ ...server(), inventory: remote }, gm, T1);
      expect(form().inventory).toEqual(remote);
      expect(store.getState().resets).toEqual([expect.objectContaining({ path: 'inventory', theirs: remote })]);
    });

    it('re-applies the normalizer to the merged form', () => {
      const { store, form } = setup({ normalize: (d) => ({ ...d, hitDice: d.hitDice || [] }) });
      store.applyRemote({ ...server(), hitDice: undefined as unknown as [] }, gm, T1);
      expect(form().hitDice).toEqual([]);
    });

    it('data equal to base (own echo) only advances the timestamp, no notification', () => {
      const { store, listener } = setup();
      store.applyRemote(server(), gm, T1);
      expect(listener).not.toHaveBeenCalled();
      expect(store.getState().baseUpdatedAt).toBe(T1);
    });

    it('an update older than base is ignored (base never moves backwards)', () => {
      const { store, form } = setup({ updatedAt: T2 });
      expect(store.applyRemote({ ...server(), experiencePoints: 1 }, gm, T1)).toBe(false);
      expect(form().experiencePoints).toBe(100);
    });

    it('resets accumulate until dismissed', () => {
      const { store } = setup();
      store.edit('experiencePoints', 100, 110);
      store.editWith('conditions', () => ['prone']);
      store.applyRemote({ ...server(), experiencePoints: 200 }, gm, T1);
      store.applyRemote({ ...server(), experiencePoints: 200, conditions: ['poisoned'] }, gm, T2);
      expect(store.getState().resets.map((r) => r.path)).toEqual(['experiencePoints', 'conditions']);
      store.dismissResets();
      expect(store.getState().resets).toEqual([]);
    });
  });

  describe('snapshotForSave / adoptSaved', () => {
    it('snapshot is an atomic deep copy of base and form', () => {
      const { store } = setup();
      store.edit('experiencePoints', 100, 175);
      const snap = store.snapshotForSave();
      expect(snap.base.experiencePoints).toBe(100);
      expect(snap.form.experiencePoints).toBe(175);
      snap.form.hp.current = 0;
      expect((store.getState().form as any).hp.current).toBe(8);
    });

    it('adoptSaved moves base to the answer and keeps edits typed during the save', () => {
      const { store, form } = setup();
      store.edit('experiencePoints', 100, 175);
      store.snapshotForSave();
      store.edit('characterName', 'Tomin', 'Typing…');
      store.adoptSaved({ ...server(), experiencePoints: 175 }, T1);
      expect(store.getState().base.experiencePoints).toBe(175);
      expect(form().characterName).toBe('Typing…');
      expect([...store.getState().touched]).toEqual(['characterName']);
    });

    it('adoptSaved: a server-normalized field the user edited during the save is reported as "server"', () => {
      const { store, form } = setup();
      store.edit('experiencePoints', 100, 175);
      store.snapshotForSave();
      store.edit('experiencePoints', 175, 180);
      store.adoptSaved({ ...server(), experiencePoints: 170 }, T1);
      expect(form().experiencePoints).toBe(170);
      expect(store.getState().resets).toEqual([
        expect.objectContaining({ path: 'experiencePoints', mine: 180, theirs: 170, author: SERVER_AUTHOR }),
      ]);
    });

    it('adoptSaved never moves base backwards past a newer adopted broadcast', () => {
      const { store, form } = setup();
      store.edit('experiencePoints', 100, 175);
      store.snapshotForSave();
      const newer = { ...server(), experiencePoints: 175, conditions: ['prone'] };
      store.applyRemote(newer, gm, T2);
      expect(store.adoptSaved({ ...server(), experiencePoints: 175 }, T1)).toBe(false);
      expect(store.getState().base).toEqual(newer);
      expect(store.getState().baseUpdatedAt).toBe(T2);
      expect(form().conditions).toEqual(['prone']);
      expect(store.getState().touched.size).toBe(0);
    });
  });

  it('discard drops the edits (form = normalized base) and keeps resets', () => {
    const { store, form } = setup({ updatedAt: T0, normalize: (d) => ({ ...d, extra: true }) });
    store.edit('experiencePoints', 100, 110);
    store.applyRemote({ ...server(), experiencePoints: 200 }, gm, T1);
    store.edit('hp.current', 8, 1);
    store.discard();
    expect(form()).toEqual({ ...server(), experiencePoints: 200, extra: true });
    expect(store.getState().touched.size).toBe(0);
    expect(store.getState().resets).toHaveLength(1);
  });

  it('unsubscribe stops notifications', () => {
    const store = createCharacterFormStore(server());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.edit('experiencePoints', 100, 1);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('round 5: owned paths, in-flight saves', () => {
  const changesOf = (store: ReturnType<typeof createCharacterFormStore>) => {
    const snap = store.snapshotForSave();
    store.endSave();
    return diffPaths(snap.base, snap.sent).map((path) => ({
      path,
      base: getAtPath(snap.base, path),
      value: getAtPath(snap.sent, path),
    }));
  };

  it('cancel (discard) during an in-flight save: the answer is adopted as is, the next save sends nothing for it', () => {
    const normalize = (d: any) => ({ ...d, extra: true });
    const { store, form } = setup({ updatedAt: T0, normalize });
    store.edit('experiencePoints', 100, 120);
    store.snapshotForSave();
    store.discard();
    store.adoptSaved({ ...server(), experiencePoints: 120 }, T1);
    expect(form()).toEqual(normalize({ ...server(), experiencePoints: 120 }));
    store.applyRemote({ ...server(), experiencePoints: 120 }, gm, T1); // late echo
    store.edit('characterName', 'Tomin', 'Tomin the Bold');
    expect(changesOf(store)).toEqual([{ path: 'characterName', base: 'Tomin', value: 'Tomin the Bold' }]);
  });

  it('the echo of the own save before its answer, while the user retypes that field: no reset, the typed value stays', () => {
    const { store, form } = setup();
    store.edit('experiencePoints', 100, 120);
    store.snapshotForSave();
    store.edit('experiencePoints', 120, 130); // typing during the save
    store.applyRemote({ ...server(), experiencePoints: 120 }, gm, T1); // echo first
    expect(form().experiencePoints).toBe(130);
    expect(store.getState().resets).toEqual([]);
    store.adoptSaved({ ...server(), experiencePoints: 120 }, T1);
    expect(form().experiencePoints).toBe(130);
    expect(store.getState().resets).toEqual([]);
    expect(changesOf(store)).toEqual([{ path: 'experiencePoints', base: 120, value: 130 }]);
  });

  it('the echo before the answer without retyping: clean afterwards', () => {
    const { store, form } = setup();
    store.edit('experiencePoints', 100, 120);
    store.snapshotForSave();
    store.applyRemote({ ...server(), experiencePoints: 120 }, gm, T1);
    store.adoptSaved({ ...server(), experiencePoints: 120 }, T1);
    expect(form().experiencePoints).toBe(120);
    expect(store.getState().touched.size).toBe(0);
    expect(store.getState().resets).toEqual([]);
  });

  it('retyping the pre-save value during the save is still a user edit after the echo', () => {
    const { store, form } = setup();
    store.edit('experiencePoints', 100, 120);
    store.snapshotForSave();
    store.edit('experiencePoints', 120, 100);
    store.applyRemote({ ...server(), experiencePoints: 120 }, gm, T1);
    store.adoptSaved({ ...server(), experiencePoints: 120 }, T1);
    expect(form().experiencePoints).toBe(100);
    expect(changesOf(store)).toEqual([{ path: 'experiencePoints', base: 120, value: 100 }]);
  });

  it('conflict re-fetch during the save: applied fields are our own write, the conflicting one resets', () => {
    const { store, form } = setup();
    store.edit('experiencePoints', 100, 120);
    store.edit('hp.current', 8, 5);
    store.snapshotForSave();
    store.edit('experiencePoints', 120, 125);
    // experiencePoints applied, hp.current conflicted (someone set 2)
    store.applyRemote(
      { ...server(), experiencePoints: 120, hp: { current: 2, maximum: 10, temporary: 0 } },
      UNKNOWN_AUTHOR,
      T1,
    );
    store.endSave();
    expect(form().experiencePoints).toBe(125);
    expect(form().hp.current).toBe(2);
    expect(store.getState().resets).toEqual([
      expect.objectContaining({ path: 'hp.current', mine: 5, theirs: 2, author: UNKNOWN_AUTHOR }),
    ]);
  });

  it('adoptSaved credits a change to a field the user did not send to someone else, not "server"', () => {
    const { store } = setup();
    store.edit('experiencePoints', 100, 120);
    store.snapshotForSave();
    store.edit('characterName', 'Tomin', 'Typed'); // typed during the save, not sent
    store.adoptSaved({ ...server(), experiencePoints: 120, characterName: 'Other' }, T1);
    expect(store.getState().resets).toEqual([
      expect.objectContaining({ path: 'characterName', mine: 'Typed', theirs: 'Other', author: UNKNOWN_AUTHOR }),
    ]);
  });

  it('derived values are saved only when their inputs were edited (recalculation on open is display-only)', () => {
    const { store, form } = setup();
    const inputsOf = (path: string) => (path === 'stats.strength.modifier' ? ['stats.strength.score'] : []);
    store.derive((f: any) => ({ ...f, stats: { strength: { score: 15, modifier: 9 } } }), inputsOf);
    expect(changesOf(store)).toEqual([]);
    store.edit('stats.strength.score', 15, 18);
    store.derive((f: any) => ({ ...f, stats: { strength: { ...f.stats.strength, modifier: 4 } } }), inputsOf);
    expect(store.getState().derived.has('stats.strength.modifier')).toBe(true);
    expect(changesOf(store)).toEqual([
      { path: 'stats.strength.score', base: 15, value: 18 },
      { path: 'stats.strength.modifier', base: 2, value: 4 },
    ]);
    expect(form().stats.strength.modifier).toBe(4);
  });

  it('a display-only derived value takes the server value on the next update', () => {
    const { store, form } = setup();
    store.derive((f: any) => ({ ...f, stats: { strength: { score: 15, modifier: 9 } } }));
    store.applyRemote({ ...server(), experiencePoints: 150 }, gm, T1);
    expect(form().stats.strength.modifier).toBe(2);
  });

  it('derived values chain through derived inputs (modifier → saving throw)', () => {
    const { store } = setup();
    const inputsOf = (path: string) =>
      path.startsWith('stats.') ? ['stats.strength.score'] : path.startsWith('savingThrows') ? ['stats.strength.modifier'] : [];
    store.edit('stats.strength.score', 15, 18);
    store.derive((f: any) => ({ ...f, stats: { strength: { score: 18, modifier: 4 } } }), inputsOf);
    store.derive((f: any) => ({ ...f, savingThrows: { strength: { bonus: 4 } } }), inputsOf);
    expect(changesOf(store).map((c) => c.path)).toEqual(['stats.strength.score', 'stats.strength.modifier', 'savingThrows']);
  });

  it('snapshotForSave sends only owned paths; normalisation is not sent', () => {
    const { store } = setup({ updatedAt: T0, normalize: (d) => ({ ...d, deathSaves: { successes: 0, failures: 0 } }) });
    store.edit('characterName', 'Tomin', 'X');
    const snap = store.snapshotForSave();
    expect(snap.sent).toEqual({ ...server(), characterName: 'X' });
    expect(snap.form.deathSaves).toEqual({ successes: 0, failures: 0 });
  });

  it('endSave after a failed save: pruning compares with base again', () => {
    const { store } = setup();
    store.edit('experiencePoints', 100, 120);
    store.snapshotForSave();
    store.edit('experiencePoints', 120, 100); // back to base while in flight: still pending
    expect(store.getState().touched.size).toBe(1);
    store.endSave();
    expect(store.getState().touched.size).toBe(0);
  });
});
