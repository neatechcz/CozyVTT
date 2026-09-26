import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Character } from '@/types';
import { useLiveCharacterSync } from '../useLiveCharacterSync';
import { diffPaths, getAtPath } from '@/utils/character-paths';
import { getFormValue, type CharacterFormStore } from '@/utils/characterFormStore';

const mocks = vi.hoisted(() => ({
  patchCharacterData: vi.fn(),
  getCharacter: vi.fn(),
  updateCharacter: vi.fn(),
}));

vi.mock('@/services/api', () => {
  const api = {
    patchCharacterData: mocks.patchCharacterData,
    getCharacter: mocks.getCharacter,
    updateCharacter: mocks.updateCharacter,
  };
  return { api, default: api };
});

type Listener = (payload: any) => void;

function createFakeSocket() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on: vi.fn((event: string, cb: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    }),
    off: vi.fn((event: string, cb?: Listener) => {
      if (cb) listeners.get(event)?.delete(cb);
      else listeners.delete(event);
    }),
    emit(event: string, payload: unknown) {
      listeners.get(event)?.forEach((cb) => cb(payload));
    },
    count(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

const baseData = () => ({
  characterName: 'Tomin',
  experiencePoints: 100,
  hp: { current: 8, maximum: 10, temporary: 0 },
  currency: { cp: 0, sp: 0, ep: 0, gp: 12, pp: 0 },
  inventory: [{ name: 'Rope' }],
  conditions: [] as string[],
});

function makeCharacter(data: Record<string, unknown>, overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1',
    userId: 'owner',
    campaignId: 'camp-1',
    gameSystem: 'DND_5E' as Character['gameSystem'],
    name: 'Tomin',
    data: data as unknown as Character['data'],
    tokenImageUrl: null,
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    ...overrides,
  };
}

const gm = { userId: 'gm', displayName: 'Pán jeskyně' };

function remoteEvent(data: Record<string, unknown>, changedPaths: string[], characterId = 'char-1') {
  return {
    characterId,
    character: makeCharacter(data, { id: characterId }),
    userId: gm.userId,
    changedPaths,
    updatedBy: gm,
  };
}

function setup(options: { isDnd5e?: boolean; data?: Record<string, unknown> } = {}) {
  const socket = createFakeSocket();
  const onServerCharacter = vi.fn();
  const character = makeCharacter(options.data ?? baseData());
  const hook = renderHook(() =>
    useLiveCharacterSync({
      character,
      socket,
      isDnd5e: options.isDnd5e ?? true,
      onServerCharacter,
    }),
  );
  return { socket, hook, onServerCharacter, character };
}

beforeEach(() => {
  mocks.patchCharacterData.mockReset();
  mocks.getCharacter.mockReset();
  mocks.updateCharacter.mockReset();
});


type Hook = ReturnType<typeof setup>['hook'];

const storeOf = (hook: Hook): CharacterFormStore => {
  const store = hook.result.current.formStore;
  if (!store) throw new Error('no form store');
  return store;
};
const formOf = (hook: Hook) => storeOf(hook).getState().form as Record<string, any>;

/** The user edits the form, field by field, on the form as it is now. */
function userEdits(hook: Hook, data: Record<string, unknown>) {
  act(() => {
    const store = storeOf(hook);
    for (const path of diffPaths(store.getState().form, data)) {
      store.edit(path, getFormValue(store.getState().form, path), getAtPath(data, path));
    }
  });
}

describe('useLiveCharacterSync', () => {
  it('starts clean: a store with the character data, no resets, subscribed once', () => {
    const { hook, socket } = setup();
    expect(formOf(hook)).toEqual(baseData());
    expect(storeOf(hook).getState().version).toBe(0);
    expect(hook.result.current.resets).toEqual([]);
    expect(hook.result.current.isDirty).toBe(false);
    expect(socket.count('character.updated')).toBe(1);
  });

  it('does nothing for non-D&D 5e characters', () => {
    const { socket, hook } = setup({ isDnd5e: false });
    expect(socket.on).not.toHaveBeenCalled();
    expect(hook.result.current.formStore).toBeNull();
  });

  it('normalizes the form with normalizeForm', () => {
    const socket = createFakeSocket();
    const hook = renderHook(() =>
      useLiveCharacterSync({
        character: makeCharacter(baseData()),
        socket,
        isDnd5e: true,
        normalizeForm: (d) => ({ ...d, deathSaves: { successes: 0, failures: 0 } }),
      }),
    );
    expect(hook.result.current.formStore!.getState().form.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(hook.result.current.isDirty).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const { hook, socket } = setup();
    hook.unmount();
    expect(socket.count('character.updated')).toBe(0);
  });

  it('adopts the remote data when nothing is dirty', () => {
    const { hook, socket, onServerCharacter } = setup();
    const remote = { ...baseData(), experiencePoints: 150 };

    act(() => socket.emit('character.updated', remoteEvent(remote, ['experiencePoints'])));

    expect(storeOf(hook).getState().version).toBe(1);
    expect(formOf(hook)).toEqual(remote);
    expect(hook.result.current.resets).toEqual([]);
    expect(onServerCharacter).toHaveBeenCalledWith(expect.objectContaining({ id: 'char-1' }));
  });

  it('ignores events for other characters', () => {
    const { hook, socket } = setup();
    act(() =>
      socket.emit('character.updated', remoteEvent({ ...baseData(), experiencePoints: 1 }, ['experiencePoints'], 'other')),
    );
    expect(storeOf(hook).getState().version).toBe(0);
    expect(formOf(hook)).toEqual(baseData());
  });

  it('merges a remote update into the form, keeping local-only edits', () => {
    const { hook, socket } = setup();
    userEdits(hook, { ...baseData(), characterName: 'Tomin the Bold' });
    expect(hook.result.current.isDirty).toBe(true);

    act(() =>
      socket.emit('character.updated', remoteEvent({ ...baseData(), experiencePoints: 150 }, ['experiencePoints'])),
    );

    expect(formOf(hook)).toEqual({ ...baseData(), characterName: 'Tomin the Bold', experiencePoints: 150 });
    expect(hook.result.current.resets).toEqual([]);
    expect(hook.result.current.isDirty).toBe(true);
  });

  it('resets a field both sides changed and records it with the author', () => {
    const { hook, socket } = setup();
    userEdits(hook, { ...baseData(), hp: { current: 5, maximum: 10, temporary: 0 } });

    act(() =>
      socket.emit('character.updated', remoteEvent({ ...baseData(), hp: { current: 3, maximum: 10, temporary: 0 } }, ['hp.current'])),
    );

    expect(formOf(hook)).toEqual({ ...baseData(), hp: { current: 3, maximum: 10, temporary: 0 } });
    expect(hook.result.current.resets).toEqual([
      expect.objectContaining({ path: 'hp.current', mine: 5, theirs: 3, author: gm }),
    ]);
    // The reset field now equals the server, so nothing is left dirty.
    expect(hook.result.current.isDirty).toBe(false);
  });

  it('accumulates resets across events until dismissed', () => {
    const { hook, socket } = setup();
    userEdits(hook, { ...baseData(), experiencePoints: 110, conditions: ['prone'] });
    act(() =>
      socket.emit('character.updated', remoteEvent({ ...baseData(), experiencePoints: 200 }, ['experiencePoints'])),
    );
    act(() =>
      socket.emit(
        'character.updated',
        remoteEvent({ ...baseData(), experiencePoints: 200, conditions: ['poisoned'] }, ['conditions']),
      ),
    );

    expect(hook.result.current.resets.map((r) => r.path)).toEqual(['experiencePoints', 'conditions']);

    act(() => hook.result.current.dismissResets());
    expect(hook.result.current.resets).toEqual([]);
  });

  it('does not report resets for derived (non-user) form changes such as editor defaults', () => {
    const { hook, socket } = setup();
    act(() => storeOf(hook).derive((f) => ({ ...f, deathSaves: { successes: 0, failures: 0 } })));
    expect(hook.result.current.isDirty).toBe(false);

    act(() =>
      socket.emit(
        'character.updated',
        remoteEvent({ ...baseData(), deathSaves: { successes: 1, failures: 0 } }, ['deathSaves']),
      ),
    );

    expect(hook.result.current.resets).toEqual([]);
    expect(formOf(hook)).toEqual({ ...baseData(), deathSaves: { successes: 1, failures: 0 } });
  });

  it('save() sends only the changed fields of the store snapshot and adopts the saved server state', async () => {
    const { hook, onServerCharacter } = setup();
    const local = { ...baseData(), experiencePoints: 175, conditions: ['prone'] };
    userEdits(hook, local);
    const saved = makeCharacter(local, { updatedAt: '2026-09-26T01:00:00.000Z' });
    mocks.patchCharacterData.mockResolvedValue({
      character: saved,
      applied: ['experiencePoints', 'conditions'],
      conflicts: [],
      status: 200,
    });

    let outcome: Awaited<ReturnType<typeof hook.result.current.save>> | undefined;
    await act(async () => {
      // Whatever a caller passes is ignored: the store is the source of truth.
      outcome = await hook.result.current.save({ stale: true });
    });

    expect(mocks.patchCharacterData).toHaveBeenCalledTimes(1);
    const [id, changes] = mocks.patchCharacterData.mock.calls[0];
    expect(id).toBe('char-1');
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: 'experiencePoints', base: 100, value: 175 },
        { path: 'conditions', base: [], value: ['prone'] },
      ]),
    );
    expect(changes).toHaveLength(2);
    expect(outcome?.status).toBe('saved');
    expect(mocks.getCharacter).not.toHaveBeenCalled();
    expect(hook.result.current.resets).toEqual([]);
    expect(hook.result.current.isDirty).toBe(false);
    expect(onServerCharacter).toHaveBeenCalledWith(saved);
    expect(storeOf(hook).getState().base).toEqual(local);
  });

  it('save() with nothing changed does not call the API', async () => {
    const { hook } = setup();
    let outcome: Awaited<ReturnType<typeof hook.result.current.save>> | undefined;
    await act(async () => {
      outcome = await hook.result.current.save();
    });
    expect(mocks.patchCharacterData).not.toHaveBeenCalled();
    expect(outcome?.status).toBe('unchanged');
  });

  it('the echo of the own save produces no resets', async () => {
    const { hook, socket } = setup();
    const local = { ...baseData(), experiencePoints: 175 };
    userEdits(hook, local);
    mocks.patchCharacterData.mockResolvedValue({
      character: makeCharacter(local),
      applied: ['experiencePoints'],
      conflicts: [],
      status: 200,
    });
    await act(async () => {
      await hook.result.current.save();
    });

    act(() => socket.emit('character.updated', remoteEvent(local, ['experiencePoints'])));

    expect(hook.result.current.resets).toEqual([]);
    expect(hook.result.current.isDirty).toBe(false);
  });

  it('the echo arriving before the PATCH response produces no resets', async () => {
    const { hook, socket } = setup();
    const local = { ...baseData(), experiencePoints: 175, inventory: [{ name: 'Rope' }, { name: 'Lute' }] };
    userEdits(hook, local);

    let resolvePatch!: (value: unknown) => void;
    mocks.patchCharacterData.mockReturnValue(new Promise((resolve) => (resolvePatch = resolve)));

    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = hook.result.current.save();
    });
    act(() => socket.emit('character.updated', remoteEvent(local, ['experiencePoints', 'inventory'])));
    await act(async () => {
      resolvePatch({ character: makeCharacter(local), applied: ['experiencePoints', 'inventory'], conflicts: [], status: 200 });
      await savePromise;
    });

    expect(hook.result.current.resets).toEqual([]);
    expect(hook.result.current.isDirty).toBe(false);
  });

  it('save() conflicts: re-fetches, merges and records the conflicting field', async () => {
    const { hook } = setup();
    const local = { ...baseData(), experiencePoints: 175, hp: { current: 5, maximum: 10, temporary: 0 } };
    userEdits(hook, local);

    const current = { ...baseData(), experiencePoints: 175, hp: { current: 2, maximum: 10, temporary: 0 } };
    mocks.patchCharacterData.mockResolvedValue({
      character: makeCharacter(current),
      applied: ['experiencePoints'],
      conflicts: [{ path: 'hp.current', base: 8, current: 2, attempted: 5 }],
      status: 200,
    });
    mocks.getCharacter.mockResolvedValue({
      character: makeCharacter(current, { updatedAt: '2026-09-26T00:00:03.000Z' }),
    });

    let outcome: Awaited<ReturnType<typeof hook.result.current.save>> | undefined;
    await act(async () => {
      outcome = await hook.result.current.save();
    });

    expect(mocks.getCharacter).toHaveBeenCalledWith('char-1');
    expect(outcome?.status).toBe('conflicts');
    expect(formOf(hook)).toEqual(current);
    expect(hook.result.current.resets).toEqual([
      expect.objectContaining({ path: 'hp.current', mine: 5, theirs: 2 }),
    ]);
    expect(hook.result.current.isDirty).toBe(false);
  });

  it('save() conflicts on a change whose broadcast was never received get an unknown author (409)', async () => {
    const { hook, socket } = setup();
    // A remote event the user did not collide with (different field) is seen first.
    userEdits(hook, { ...baseData(), hp: { current: 5, maximum: 10, temporary: 0 } });
    const mid = { ...baseData(), experiencePoints: 120 };
    act(() => socket.emit('character.updated', remoteEvent(mid, ['experiencePoints'])));

    const current = { ...mid, hp: { current: 1, maximum: 10, temporary: 0 } };
    mocks.patchCharacterData.mockResolvedValue({
      character: makeCharacter(current),
      applied: [],
      conflicts: [{ path: 'hp.current', base: 8, current: 1, attempted: 5 }],
      status: 409,
    });
    mocks.getCharacter.mockResolvedValue({ character: makeCharacter(current) });

    // hp.current was changed by someone whose broadcast we never received.
    await act(async () => {
      await hook.result.current.save();
    });

    expect(hook.result.current.resets).toEqual([
      expect.objectContaining({ path: 'hp.current', mine: 5, theirs: 1, author: { userId: null, displayName: 'někdo jiný' } }),
    ]);
  });

  it('keeps edits made while the save was in flight', async () => {
    const { hook } = setup();
    const local = { ...baseData(), experiencePoints: 175 };
    userEdits(hook, local);

    let resolvePatch!: (value: unknown) => void;
    mocks.patchCharacterData.mockReturnValue(new Promise((resolve) => (resolvePatch = resolve)));
    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = hook.result.current.save();
    });
    userEdits(hook, { ...local, characterName: 'Typing…' });
    await act(async () => {
      resolvePatch({ character: makeCharacter(local), applied: ['experiencePoints'], conflicts: [], status: 200 });
      await savePromise;
    });

    expect(mocks.patchCharacterData.mock.calls[0][1]).toEqual([{ path: 'experiencePoints', base: 100, value: 175 }]);
    expect(formOf(hook)).toEqual({ ...local, characterName: 'Typing…' });
    expect(hook.result.current.isDirty).toBe(true);
  });

  it('save() conflicts whose path runs through a non-object (inventory.0, current undefined) merge like any other', async () => {
    const { hook } = setup();
    const local = { ...baseData(), inventory: [{ name: 'Rope' }, { name: 'Lute' }] };
    userEdits(hook, local);

    const current = { ...baseData(), inventory: [] as unknown[] };
    mocks.patchCharacterData.mockResolvedValue({
      character: makeCharacter(current),
      applied: [],
      conflicts: [{ path: 'inventory.0', base: { name: 'Rope' }, current: undefined, attempted: { name: 'Rope' } }],
      status: 409,
    });
    mocks.getCharacter.mockResolvedValue({ character: makeCharacter(current) });

    let outcome: Awaited<ReturnType<typeof hook.result.current.save>> | undefined;
    await act(async () => {
      outcome = await hook.result.current.save();
    });

    expect(outcome?.status).toBe('conflicts');
    expect(formOf(hook)).toEqual(current);
    expect(hook.result.current.resets).toEqual([
      expect.objectContaining({ path: 'inventory', mine: local.inventory, theirs: [] }),
    ]);
  });

  it('handles events whose changedPaths is [""] (whole document)', () => {
    const { hook, socket } = setup();
    userEdits(hook, { ...baseData(), characterName: 'Mine' });
    act(() => socket.emit('character.updated', remoteEvent({ ...baseData(), experiencePoints: 5 }, [''])));
    expect(formOf(hook)).toEqual({ ...baseData(), characterName: 'Mine', experiencePoints: 5 });
    expect(hook.result.current.resets).toEqual([]);
  });

  it('falls back to the full-document PUT when the change is not path-addressable', async () => {
    const odd = { ...baseData(), 'bad-key': 1 };
    const { hook, onServerCharacter } = setup({ data: odd });
    const local = { ...odd, 'bad-key': 2, experiencePoints: 101 };
    userEdits(hook, local);
    expect(hook.result.current.isDirty).toBe(true);

    const saved = makeCharacter(local);
    mocks.updateCharacter.mockResolvedValue({ message: 'ok', character: saved });

    let outcome: Awaited<ReturnType<typeof hook.result.current.save>> | undefined;
    await act(async () => {
      outcome = await hook.result.current.save();
    });

    expect(mocks.patchCharacterData).not.toHaveBeenCalled();
    expect(mocks.updateCharacter).toHaveBeenCalledWith('char-1', { data: local });
    expect(outcome?.status).toBe('saved');
    expect(hook.result.current.isDirty).toBe(false);
    expect(onServerCharacter).toHaveBeenCalledWith(saved);
  });

  it('discard() drops local edits (not dirty, no later false resets) and keeps resets', () => {
    const { hook, socket } = setup();
    userEdits(hook, { ...baseData(), experiencePoints: 110 });
    act(() =>
      socket.emit('character.updated', remoteEvent({ ...baseData(), experiencePoints: 200 }, ['experiencePoints'])),
    );
    userEdits(hook, { ...baseData(), experiencePoints: 200, hp: { current: 1, maximum: 10, temporary: 0 } });
    expect(hook.result.current.isDirty).toBe(true);
    expect(hook.result.current.resets).toHaveLength(1);

    act(() => storeOf(hook).discard());
    expect(hook.result.current.isDirty).toBe(false);
    expect(hook.result.current.resets).toHaveLength(1);

    // A later remote change to the discarded field is simply adopted.
    act(() =>
      socket.emit(
        'character.updated',
        remoteEvent({ ...baseData(), experiencePoints: 200, hp: { current: 9, maximum: 10, temporary: 0 } }, ['hp.current']),
      ),
    );
    expect(hook.result.current.resets).toHaveLength(1);
    expect(formOf(hook)).toEqual({ ...baseData(), experiencePoints: 200, hp: { current: 9, maximum: 10, temporary: 0 } });
  });

  it('a save response older than an already adopted broadcast does not move base backwards', async () => {
    const { hook, socket } = setup();
    const local = { ...baseData(), experiencePoints: 175 };
    userEdits(hook, local);

    let resolvePatch!: (value: unknown) => void;
    mocks.patchCharacterData.mockReturnValue(new Promise((resolve) => (resolvePatch = resolve)));
    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = hook.result.current.save();
    });

    // Someone else wrote after our save; their broadcast (T2) arrives first.
    const newer = { ...local, conditions: ['prone'] };
    act(() =>
      socket.emit('character.updated', {
        ...remoteEvent(newer, ['conditions']),
        character: makeCharacter(newer, { updatedAt: '2026-09-26T00:00:02.000Z' }),
      }),
    );
    await act(async () => {
      resolvePatch({
        character: makeCharacter(local, { updatedAt: '2026-09-26T00:00:01.000Z' }),
        applied: ['experiencePoints'],
        conflicts: [],
        status: 200,
      });
      await savePromise;
    });

    expect(formOf(hook)).toEqual(newer);
    expect(hook.result.current.isDirty).toBe(false);

    // Base is still T2: saving the same data changes nothing.
    let outcome: Awaited<ReturnType<typeof hook.result.current.save>> | undefined;
    await act(async () => {
      outcome = await hook.result.current.save();
    });
    expect(outcome?.status).toBe('unchanged');
    expect(mocks.patchCharacterData).toHaveBeenCalledTimes(1);
  });

  it('falls back to the full-document PUT when there are more than 200 changes', async () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 201; i++) many[`f${i}`] = 0;
    const { hook } = setup({ data: many });
    const local = Object.fromEntries(Object.keys(many).map((key) => [key, 1]));
    userEdits(hook, local);
    mocks.updateCharacter.mockResolvedValue({ message: 'ok', character: makeCharacter(local) });

    let outcome: Awaited<ReturnType<typeof hook.result.current.save>> | undefined;
    await act(async () => {
      outcome = await hook.result.current.save();
    });

    expect(mocks.patchCharacterData).not.toHaveBeenCalled();
    expect(mocks.updateCharacter).toHaveBeenCalledWith('char-1', { data: local });
    expect(outcome?.status).toBe('saved');
  });

  it('switching to another character gives a fresh store: no resets, not dirty', () => {
    const socket = createFakeSocket();
    const first = makeCharacter(baseData());
    const second = makeCharacter({ ...baseData(), characterName: 'Mich' }, { id: 'char-2' });
    const hook = renderHook(({ character }) => useLiveCharacterSync({ character, socket, isDnd5e: true }), {
      initialProps: { character: first },
    });
    userEdits(hook as unknown as Hook, { ...baseData(), experiencePoints: 1 });
    act(() => socket.emit('character.updated', remoteEvent({ ...baseData(), experiencePoints: 2 }, ['experiencePoints'])));
    expect(hook.result.current.resets).toHaveLength(1);
    userEdits(hook as unknown as Hook, { ...baseData(), experiencePoints: 2, conditions: ['x'] });
    expect(hook.result.current.isDirty).toBe(true);
    const firstStore = hook.result.current.formStore;

    hook.rerender({ character: second });

    expect(hook.result.current.formStore).not.toBe(firstStore);
    expect(hook.result.current.resets).toEqual([]);
    expect(hook.result.current.isDirty).toBe(false);
    expect(hook.result.current.formStore!.getState().form.characterName).toBe('Mich');
    // The old character's events no longer reach anything.
    act(() => socket.emit('character.updated', remoteEvent({ ...baseData(), experiencePoints: 3 }, ['experiencePoints'])));
    expect(hook.result.current.formStore!.getState().version).toBe(0);
  });

  it('remote 1 → stale keystrokes → remote 2: the lost one is reported, save never reverts either remote change', async () => {
    const { hook, socket } = setup();
    const L0 = baseData();
    const r1 = { ...L0, hp: { current: 3, maximum: 10, temporary: 0 } };
    act(() => socket.emit('character.updated', remoteEvent(r1, ['hp.current'])));

    // The user acted on a form that did not show remote 1 yet.
    act(() => {
      storeOf(hook).edit('characterName', 'Tomin', 'X');
      storeOf(hook).edit('hp.current', 8, 6);
    });
    expect(hook.result.current.resets).toEqual([
      expect.objectContaining({ path: 'hp.current', mine: 6, theirs: 3, author: gm }),
    ]);

    const r2 = { ...r1, experiencePoints: 400 };
    act(() => socket.emit('character.updated', remoteEvent(r2, ['experiencePoints'])));
    expect(formOf(hook)).toEqual({ ...r2, characterName: 'X' });

    mocks.patchCharacterData.mockResolvedValue({
      character: makeCharacter({ ...r2, characterName: 'X' }),
      applied: ['characterName'],
      conflicts: [],
      status: 200,
    });
    await act(async () => {
      await hook.result.current.save();
    });
    expect(mocks.patchCharacterData.mock.calls[0][1]).toEqual([{ path: 'characterName', base: 'Tomin', value: 'X' }]);
    expect(hook.result.current.resets).toHaveLength(1);
  });

  it('resets caused by the server answer to the own save are labelled "server"', async () => {
    const { hook } = setup();
    const local = { ...baseData(), experiencePoints: 175 };
    userEdits(hook, local);
    let resolvePatch!: (value: unknown) => void;
    mocks.patchCharacterData.mockReturnValue(new Promise((resolve) => (resolvePatch = resolve)));
    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = hook.result.current.save();
    });
    // Typed into the same field while the save was in flight; the server
    // normalised the saved value.
    userEdits(hook, { ...local, experiencePoints: 180 });
    await act(async () => {
      resolvePatch({ character: makeCharacter({ ...local, experiencePoints: 170 }), applied: ['experiencePoints'], conflicts: [], status: 200 });
      await savePromise;
    });
    expect(formOf(hook).experiencePoints).toBe(170);
    expect(hook.result.current.resets).toEqual([
      expect.objectContaining({ path: 'experiencePoints', mine: 180, theirs: 170, author: { userId: null, displayName: 'server' } }),
    ]);
  });

  it('propagates validation errors from save()', async () => {
    const { hook } = setup();
    const local = { ...baseData(), experiencePoints: -5 };
    userEdits(hook, local);
    const error = Object.assign(new Error('Validation'), { response: { status: 400, data: { validationErrors: [] } } });
    mocks.patchCharacterData.mockRejectedValue(error);

    await expect(
      act(async () => {
        await hook.result.current.save();
      }),
    ).rejects.toBe(error);
    expect(hook.result.current.isDirty).toBe(true);
  });
});

describe('useLiveCharacterSync — round 5', () => {
  function pendingPatch() {
    let resolvePatch!: (value: unknown) => void;
    mocks.patchCharacterData.mockReturnValue(new Promise((resolve) => (resolvePatch = resolve)));
    return (value: unknown) => resolvePatch(value);
  }

  it('cancel (discard) while the save is in flight: the answer is adopted, the next save sends nothing for that field', async () => {
    const { hook } = setup();
    userEdits(hook, { ...baseData(), experiencePoints: 120 });
    const resolve = pendingPatch();
    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = hook.result.current.save();
    });
    act(() => storeOf(hook).discard());
    await act(async () => {
      resolve({ character: makeCharacter({ ...baseData(), experiencePoints: 120 }, { updatedAt: '2026-09-26T00:00:01.000Z' }), applied: ['experiencePoints'], conflicts: [], status: 200 });
      await savePromise;
    });
    expect(formOf(hook)).toEqual({ ...baseData(), experiencePoints: 120 });
    expect(hook.result.current.isDirty).toBe(false);

    mocks.patchCharacterData.mockReset();
    let outcome: Awaited<ReturnType<typeof hook.result.current.save>> | undefined;
    await act(async () => {
      outcome = await hook.result.current.save();
    });
    expect(outcome?.status).toBe('unchanged');
    expect(mocks.patchCharacterData).not.toHaveBeenCalled();
  });

  it('the echo of the own save before its answer, while the user retyped that field: no reset, typed value kept', async () => {
    const { hook, socket } = setup();
    userEdits(hook, { ...baseData(), experiencePoints: 120 });
    const resolve = pendingPatch();
    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = hook.result.current.save();
    });
    userEdits(hook, { ...baseData(), experiencePoints: 130 });
    const saved = makeCharacter({ ...baseData(), experiencePoints: 120 }, { updatedAt: '2026-09-26T00:00:01.000Z' });
    act(() => socket.emit('character.updated', { ...remoteEvent(saved.data as any, ['experiencePoints']), character: saved }));
    expect(hook.result.current.resets).toEqual([]);
    expect(formOf(hook).experiencePoints).toBe(130);
    await act(async () => {
      resolve({ character: saved, applied: ['experiencePoints'], conflicts: [], status: 200 });
      await savePromise;
    });
    expect(hook.result.current.resets).toEqual([]);
    expect(formOf(hook).experiencePoints).toBe(130);
    expect(hook.result.current.isDirty).toBe(true);
  });

  it('409 re-fetch: fields that were applied (equal to what we sent) are not reported, a retyped value survives', async () => {
    const { hook } = setup();
    userEdits(hook, { ...baseData(), experiencePoints: 120, hp: { current: 5, maximum: 10, temporary: 0 } });
    let resolvePatch!: (value: unknown) => void;
    mocks.patchCharacterData.mockReturnValue(new Promise((resolve) => (resolvePatch = resolve)));
    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = hook.result.current.save();
    });
    userEdits(hook, { ...formOf(hook), experiencePoints: 125 });
    const current = { ...baseData(), experiencePoints: 120, hp: { current: 2, maximum: 10, temporary: 0 } };
    mocks.getCharacter.mockResolvedValue({ character: makeCharacter(current, { updatedAt: '2026-09-26T00:00:02.000Z' }) });
    await act(async () => {
      resolvePatch({ character: makeCharacter(current), applied: ['experiencePoints'], conflicts: [{ path: 'hp.current', base: 8, current: 2, attempted: 5 }], status: 200 });
      await savePromise;
    });
    expect(formOf(hook).experiencePoints).toBe(125);
    expect(hook.result.current.resets).toEqual([expect.objectContaining({ path: 'hp.current', mine: 5, theirs: 2 })]);
  });

  it('onServerCharacter only gets data the store adopted: an older save answer or older event is not forwarded', async () => {
    const { hook, socket, onServerCharacter } = setup();
    const newer = makeCharacter({ ...baseData(), conditions: ['prone'] }, { updatedAt: '2026-09-26T00:00:05.000Z' });
    act(() => socket.emit('character.updated', { ...remoteEvent(newer.data as any, ['conditions']), character: newer }));
    expect(onServerCharacter).toHaveBeenCalledTimes(1);

    const older = makeCharacter({ ...baseData(), experiencePoints: 1 }, { updatedAt: '2026-09-26T00:00:03.000Z' });
    act(() => socket.emit('character.updated', { ...remoteEvent(older.data as any, ['experiencePoints']), character: older }));
    expect(onServerCharacter).toHaveBeenCalledTimes(1);
    expect(formOf(hook).experiencePoints).toBe(100);

    userEdits(hook, { ...formOf(hook), characterName: 'X' });
    mocks.patchCharacterData.mockResolvedValue({
      character: makeCharacter({ ...baseData(), characterName: 'X' }, { updatedAt: '2026-09-26T00:00:04.000Z' }),
      applied: ['characterName'],
      conflicts: [],
      status: 200,
    });
    await act(async () => {
      await hook.result.current.save();
    });
    expect(onServerCharacter).toHaveBeenCalledTimes(1);
  });

  it('a failed save ends the in-flight state (pruning compares with base again)', async () => {
    const { hook } = setup();
    userEdits(hook, { ...baseData(), experiencePoints: 120 });
    mocks.patchCharacterData.mockRejectedValue(new Error('network'));
    await expect(
      act(async () => {
        await hook.result.current.save();
      }),
    ).rejects.toThrow('network');
    // Back to the server value: not pending any more (no save is in flight).
    act(() => {
      storeOf(hook).edit('experiencePoints', 120, 100);
    });
    expect(storeOf(hook).getState().touched.size).toBe(0);
  });

  it('a save answer that changed a field the user did not send credits "někdo jiný", not "server"', async () => {
    const { hook } = setup();
    userEdits(hook, { ...baseData(), experiencePoints: 120 });
    const resolve = pendingPatch();
    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = hook.result.current.save();
    });
    userEdits(hook, { ...formOf(hook), characterName: 'Typed' }); // not part of the save
    await act(async () => {
      resolve({
        character: makeCharacter({ ...baseData(), experiencePoints: 120, characterName: 'Other' }, { updatedAt: '2026-09-26T00:00:01.000Z' }),
        applied: ['experiencePoints'],
        conflicts: [],
        status: 200,
      });
      await savePromise;
    });
    expect(hook.result.current.resets).toEqual([
      expect.objectContaining({ path: 'characterName', mine: 'Typed', theirs: 'Other', author: { userId: null, displayName: 'někdo jiný' } }),
    ]);
  });
});

