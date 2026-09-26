/**
 * Editor + wrapper + hook together: the handshake between
 * useLiveCharacterSync and DnD5eCharacterEditor.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Character } from '@/types';
import { useLiveCharacterSync } from '@/hooks/useLiveCharacterSync';
import { api } from '@/services/api';
import { DnD5eCharacterSheet } from '../DnD5eCharacterSheet';
import { buildDnd5eFormData } from '../dnd5eFormData';

vi.mock('@/services/api', () => {
  const api = { patchCharacterData: vi.fn(), getCharacter: vi.fn(), updateCharacter: vi.fn(), uploadAsset: vi.fn() };
  return { api, default: api };
});

type Listener = (payload: any) => void;

function createFakeSocket() {
  const listeners = new Set<Listener>();
  return {
    on: (_event: string, cb: Listener) => listeners.add(cb),
    off: (_event: string, cb?: Listener) => {
      if (cb) listeners.delete(cb);
    },
    emit: (payload: unknown) => listeners.forEach((cb) => cb(payload)),
  };
}

const ability = (score: number) => ({ score, modifier: Math.floor((score - 10) / 2) });

const data = {
  characterName: 'Tomin',
  class: 'Fighter',
  level: 1,
  race: 'Human',
  proficiencyBonus: 2,
  experiencePoints: 100,
  stats: {
    strength: ability(15),
    dexterity: ability(12),
    constitution: ability(14),
    intelligence: ability(10),
    wisdom: ability(10),
    charisma: ability(8),
  },
  hp: { current: 8, maximum: 12, temporary: 0 },
};

function makeCharacter(characterData: object): Character {
  return {
    id: 'char-1',
    userId: 'owner',
    campaignId: 'camp-1',
    gameSystem: 'DND_5E' as Character['gameSystem'],
    name: 'Tomin',
    data: characterData as unknown as Character['data'],
    tokenImageUrl: null,
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
  };
}

type Sync = ReturnType<typeof useLiveCharacterSync>;

function Harness({
  socket,
  before,
  after,
  initialData = data,
}: {
  socket: ReturnType<typeof createFakeSocket>;
  /** Rendered before the sheet, so its passive effects run before the editor's */
  before?: (sync: Sync, version: number) => ReactNode;
  /** Rendered after the sheet, so its passive effects run after the editor committed */
  after?: (sync: Sync, version: number) => ReactNode;
  initialData?: object;
}) {
  const [character, setCharacter] = useState(() => makeCharacter(initialData));
  const sync = useLiveCharacterSync({
    character,
    socket,
    isDnd5e: true,
    onServerCharacter: setCharacter,
    normalizeForm: buildDnd5eFormData,
  });
  const store = sync.formStore!;
  const version = useSyncExternalStore(store.subscribe, () => store.getState().version);
  return (
    <>
      <span data-testid="dirty">{String(sync.isDirty)}</span>
      <ul data-testid="resets">
        {sync.resets.map((r) => (
          <li key={`${r.path}-${r.at}`}>{`${r.path}|${JSON.stringify(r.mine)}|${JSON.stringify(r.theirs)}|${r.author.displayName}`}</li>
        ))}
      </ul>
      {before?.(sync, version)}
      <DnD5eCharacterSheet
        character={character}
        mode="edit"
        onSave={async () => {
          await sync.save();
        }}
        formStore={store}
      />
      {after?.(sync, version)}
    </>
  );
}

/** Calls an input's React onChange outside React's event system (DefaultLane, not SyncLane). */
function callReactOnChange(input: HTMLInputElement, value: string) {
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps$'))!;
  (input as any)[key].onChange({ target: { value } });
}

const nameInput = () => screen.getByPlaceholderText('Character Name') as HTMLInputElement;
const xpInput = () =>
  screen.getByText('Experience Points').parentElement!.querySelector('input') as HTMLInputElement;
const dirty = () => screen.getByTestId('dirty').textContent;
const resetLines = () => Array.from(screen.getByTestId('resets').querySelectorAll('li')).map((li) => li.textContent);

function remote(characterData: object, updatedAt = '2026-09-26T00:00:05.000Z') {
  return {
    characterId: 'char-1',
    character: { ...makeCharacter(characterData), updatedAt },
    userId: 'gm',
    changedPaths: ['experiencePoints'],
    updatedBy: { userId: 'gm', displayName: 'GM' },
  };
}

/** A PATCH mock that applies the changes onto `serverData` (like the server). */
function mockPatch(serverData: object) {
  const patch = vi.mocked(api.patchCharacterData);
  patch.mockReset();
  patch.mockImplementation(async (_id, changes) => {
    const next: any = JSON.parse(JSON.stringify(serverData));
    for (const change of changes) {
      const keys = change.path.split('.');
      let target = next;
      for (const key of keys.slice(0, -1)) target = target[key] ??= {};
      target[keys[keys.length - 1]] = change.value;
    }
    return { character: makeCharacter(next), applied: changes.map((c) => c.path), conflicts: [], status: 200 };
  });
  return patch;
}

async function clickSave() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^\s*Save\s*$/ }));
  });
}

type Change = { path: string; base?: unknown; value?: unknown };

/**
 * The screen, the panel and the next save tell the same story about a field
 * the user typed into while someone else changed it: either the user's value
 * is on screen and saved on top of the remote one, or the remote value is on
 * screen, the user's value is in the panel and the save leaves the field alone.
 */
function expectConsistent(opts: {
  path: string;
  shown: string;
  mine: unknown;
  theirs: unknown;
  changes: Change[];
}) {
  const reset = resetLines().find((line) => line?.startsWith(`${opts.path}|`));
  const sent = opts.changes.find((c) => c.path === opts.path);
  if (reset) {
    expect(reset).toBe(`${opts.path}|${JSON.stringify(opts.mine)}|${JSON.stringify(opts.theirs)}|GM`);
    expect(opts.shown).toBe(String(opts.theirs));
    expect(sent).toBeUndefined();
  } else {
    expect(opts.shown).toBe(String(opts.mine));
    // Saved on top of the remote value — never as a revert of it.
    expect(sent).toEqual({ path: opts.path, base: opts.theirs, value: opts.mine });
  }
}

describe('D&D 5e live sync (editor + store + hook)', () => {
  it('window C: a keystroke landing right after the rebase is queued: form, panel and save agree; the GM change is never reverted', async () => {
    const socket = createFakeSocket();
    function KeystrokeAfterRebase({ version }: { version: number }) {
      useEffect(() => {
        if (version !== 1) return; // only the remote update, not the discard after save
        // The user's next keystroke, right after the rebase committed
        queueMicrotask(() => fireEvent.change(xpInput(), { target: { value: '120' } }));
      }, [version]);
      return null;
    }
    render(<Harness socket={socket} after={(_sync, version) => <KeystrokeAfterRebase version={version} />} />);

    await act(async () => {
      socket.emit(remote({ ...data, experiencePoints: 150 }));
    });

    // The remote change was in the store (and on screen) before the user
    // typed: a normal edit on top of the remote value, nothing reset.
    expect(xpInput().value).toBe('120');
    expect(resetLines()).toEqual([]);
    expect(dirty()).toBe('true');

    const patch = mockPatch({ ...data, experiencePoints: 150 });
    await clickSave();
    const changes = patch.mock.calls[0][1];
    expect(changes).toContainEqual({ path: 'experiencePoints', base: 150, value: 120 });
    expectConsistent({ path: 'experiencePoints', shown: '120', mine: 120, theirs: 150, changes });
  });

  it('(a) a keystroke on a stale form into a field the remote just changed: remote value on screen, the loss in the panel, save leaves it alone', async () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);

    act(() => {
      socket.emit(remote({ ...data, experiencePoints: 150 }));
      fireEvent.change(xpInput(), { target: { value: '120' } });
    });

    expect(xpInput().value).toBe('150');
    expect(resetLines()).toEqual(['experiencePoints|120|150|GM']);
    expect(dirty()).toBe('false');
    const shown = xpInput().value;

    const patch = mockPatch({ ...data, experiencePoints: 150 });
    await clickSave();
    // Nothing of the user's is left to save: no request at all.
    expect(patch).not.toHaveBeenCalled();
    expectConsistent({ path: 'experiencePoints', shown, mine: 120, theirs: 150, changes: [] });
  });

  it('(b) remote 1 → keystroke → remote 2 before remote 1 is rendered: saving never reverts either remote change', async () => {
    const socket = createFakeSocket();
    const remote1 = { ...data, hp: { current: 3, maximum: 12, temporary: 0 } };
    const remote2 = { ...remote1, experiencePoints: 400 };
    render(<Harness socket={socket} />);

    act(() => {
      socket.emit(remote(remote1));
      fireEvent.change(nameInput(), { target: { value: 'Tomin the Bold' } });
      socket.emit(remote(remote2, '2026-09-26T00:00:06.000Z'));
    });

    expect(nameInput().value).toBe('Tomin the Bold');
    expect(xpInput().value).toBe('400');
    expect(resetLines()).toEqual([]);

    const patch = mockPatch(remote2);
    await clickSave();

    expect(patch).toHaveBeenCalledTimes(1);
    const changes = patch.mock.calls[0][1];
    expect(changes).toContainEqual({ path: 'characterName', base: 'Tomin', value: 'Tomin the Bold' });
    const paths = changes.map((c) => c.path);
    expect(paths).not.toContain('hp.current');
    expect(paths).not.toContain('hp');
    expect(paths).not.toContain('experiencePoints');
  });

  it('a keystroke committed together with a remote update of another field survives, and so does the remote value', () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);

    act(() => {
      socket.emit(remote({ ...data, experiencePoints: 150 }));
      fireEvent.change(nameInput(), { target: { value: 'Tomin the Bold' } });
    });

    expect(nameInput().value).toBe('Tomin the Bold');
    expect(xpInput().value).toBe('150');
    expect(dirty()).toBe('true');

    // The next remote update of a third field keeps both again.
    act(() => socket.emit(remote({ ...data, experiencePoints: 150, hp: { current: 3, maximum: 12, temporary: 0 } })));
    expect(nameInput().value).toBe('Tomin the Bold');
    expect(xpInput().value).toBe('150');
    expect(dirty()).toBe('true');
  });

  it('a derived-value update in the same render as a remote update never overwrites the remote change', async () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);
    const scoreInput = (ability: string) =>
      screen.getByText(ability).parentElement!.querySelector('input') as HTMLInputElement;

    const remoteData = { ...data, stats: { ...data.stats, strength: ability(18) } };
    act(() => {
      socket.emit(remote(remoteData));
      callReactOnChange(scoreInput('dex'), '16');
    });

    expect(scoreInput('str').value).toBe('18');
    expect(scoreInput('dex').value).toBe('16');

    const patch = mockPatch(remoteData);
    await clickSave();
    const changes = patch.mock.calls[0][1];
    const paths = changes.map((c) => c.path);
    expect(paths).not.toContain('stats.strength.score');
    expect(paths).not.toContain('stats.strength.modifier');
    expect(changes).toContainEqual({ path: 'stats.dexterity.score', base: 12, value: 16 });
    expect(changes).toContainEqual({ path: 'stats.dexterity.modifier', base: 1, value: 3 });
  });

  it.each([
    ['a different field is kept', 'name', undefined],
    ['the same field is an edit on top of the remote value', 'xp', undefined],
  ])('(c) window B: a keystroke queued before the rebase renders — %s', (_label, field, expectedReset) => {
    const socket = createFakeSocket();
    function KeystrokeWhenVersionChanges({ version }: { version: number }) {
      useEffect(() => {
        if (version !== 1) return;
        if (field === 'name') callReactOnChange(nameInput(), 'Typed');
        else callReactOnChange(xpInput(), '120');
      }, [version]);
      return null;
    }
    render(<Harness socket={socket} before={(_sync, version) => <KeystrokeWhenVersionChanges version={version} />} />);

    act(() => socket.emit(remote({ ...data, experiencePoints: 150 })));

    if (field === 'name') {
      expect(xpInput().value).toBe('150');
      expect(nameInput().value).toBe('Typed');
      expect(dirty()).toBe('true');
      expect(resetLines()).toEqual([]);
    } else {
      // The keystroke's onChange closes over the latest committed form, which
      // already shows the remote 150 (the store rendered it in the same
      // commit): a normal edit on top of it, nothing reset.
      expect(xpInput().value).toBe('120');
      expect(resetLines()).toEqual([]);
      expect(dirty()).toBe('true');
      expect(expectedReset).toBeUndefined();
    }
  });

  it('array race: the GM adds an item while the user removes another on a stale form — both changes survive', async () => {
    const socket = createFakeSocket();
    const initial = { ...data, inventory: [{ name: 'Rope' }, { name: 'Lute' }] };
    render(<Harness socket={socket} initialData={initial} />);
    fireEvent.click(screen.getByRole('button', { name: /Inventory/ }));
    const removeButton = (name: string) =>
      screen.getAllByPlaceholderText('Item Name').find((input) => (input as HTMLInputElement).value === name)!
        .parentElement!.querySelector('button') as HTMLButtonElement;
    const itemNames = () => screen.getAllByPlaceholderText('Item Name').map((input) => (input as HTMLInputElement).value);

    const gmData = { ...initial, inventory: [...initial.inventory, { name: 'Gem' }] };
    act(() => {
      socket.emit(remote(gmData));
      // The click handler still closes over the form without the Gem.
      fireEvent.click(removeButton('Lute'));
    });

    expect(itemNames()).toEqual(['Rope', 'Gem']);
    expect(resetLines()).toEqual([]);
    expect(dirty()).toBe('true');

    const patch = mockPatch(gmData);
    await clickSave();
    const changes = patch.mock.calls[0][1];
    expect(changes).toContainEqual({
      path: 'inventory',
      base: gmData.inventory,
      value: [{ name: 'Rope' }, { name: 'Gem' }],
    });
  });

  it('array race: removing an item the GM changed meanwhile loses and is reported, never silently', async () => {
    const socket = createFakeSocket();
    const initial = { ...data, inventory: [{ name: 'Rope' }, { name: 'Lute' }] };
    render(<Harness socket={socket} initialData={initial} />);
    fireEvent.click(screen.getByRole('button', { name: /Inventory/ }));
    const lute = screen.getAllByPlaceholderText('Item Name')[1];
    const removeLute = lute.parentElement!.querySelector('button') as HTMLButtonElement;

    const gmData = { ...initial, inventory: [{ name: 'Rope' }, { name: 'Lute', quantity: 2 }] };
    act(() => {
      socket.emit(remote(gmData));
      fireEvent.click(removeLute);
    });

    expect(screen.getAllByPlaceholderText('Item Name')).toHaveLength(2);
    expect(resetLines()).toEqual([
      `inventory|${JSON.stringify([{ name: 'Rope' }])}|${JSON.stringify(gmData.inventory)}|GM`,
    ]);

    const patch = mockPatch(gmData);
    await clickSave();
    expect(patch).not.toHaveBeenCalled();
  });

  it('array race: the user adds an item on a stale form while the GM adds one — both are kept', () => {
    const socket = createFakeSocket();
    const initial = { ...data, inventory: [{ name: 'Rope' }] };
    render(<Harness socket={socket} initialData={initial} />);
    fireEvent.click(screen.getByRole('button', { name: /Inventory/ }));

    act(() => {
      socket.emit(remote({ ...initial, inventory: [{ name: 'Rope' }, { name: 'Gem' }] }));
      fireEvent.click(screen.getByRole('button', { name: /Add Item/ }));
    });

    const names = screen.getAllByPlaceholderText('Item Name').map((input) => (input as HTMLInputElement).value);
    expect(names).toEqual(['Rope', 'Gem', '']);
    expect(resetLines()).toEqual([]);
  });

  it('typing into an item of an array the GM changed meanwhile is reported, not written into the wrong item', () => {
    const socket = createFakeSocket();
    const initial = { ...data, inventory: [{ name: 'Rope' }, { name: 'Lute' }] };
    render(<Harness socket={socket} initialData={initial} />);
    fireEvent.click(screen.getByRole('button', { name: /Inventory/ }));
    const luteInput = screen.getAllByPlaceholderText('Item Name')[1];

    const gmData = { ...initial, inventory: [{ name: 'Gem' }, { name: 'Rope' }, { name: 'Lute' }] };
    act(() => {
      socket.emit(remote(gmData));
      fireEvent.change(luteInput, { target: { value: 'Lute of Charm' } });
    });

    const names = screen.getAllByPlaceholderText('Item Name').map((input) => (input as HTMLInputElement).value);
    expect(names).toEqual(['Gem', 'Rope', 'Lute']);
    expect(resetLines()).toHaveLength(1);
    expect(resetLines()[0]).toMatch(/^inventory\|/);
  });

  it('a user edit committed in the same render as a remote update stays the user\'s', () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);

    act(() => {
      socket.emit(remote({ ...data, experiencePoints: 150 }));
      callReactOnChange(nameInput(), 'Typed');
    });

    expect(nameInput().value).toBe('Typed');
    expect(xpInput().value).toBe('150');
    expect(dirty()).toBe('true');

    // A later remote change of the same field is listed in the panel.
    act(() => socket.emit(remote({ ...data, experiencePoints: 150, characterName: 'GM name' }, '2026-09-26T00:00:07.000Z')));
    expect(nameInput().value).toBe('GM name');
    expect(resetLines()).toEqual(['characterName|"Typed"|"GM name"|GM']);
  });

  it('typing after a remote update is tracked as a user edit', () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);
    act(() => socket.emit(remote({ ...data, experiencePoints: 150 })));
    expect(dirty()).toBe('false');

    fireEvent.change(nameInput(), { target: { value: 'Typed' } });
    expect(dirty()).toBe('true');
  });

  it('opening the editor (normalization, derived values) is not dirty', () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);
    expect(nameInput().value).toBe('Tomin');
    expect(dirty()).toBe('false');
  });

  it('cancel discards the edits: not dirty any more', () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);
    fireEvent.change(nameInput(), { target: { value: 'Unsaved' } });
    expect(dirty()).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));

    expect(screen.queryByPlaceholderText('Character Name')).not.toBeInTheDocument();
    expect(dirty()).toBe('false');
  });

  it('a colour picked in the editor is saved as a field edit; the GM\'s colour change is shown, not reverted', async () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);
    act(() => socket.emit(remote({ ...data, themeColor: '#123456' })));
    fireEvent.change(nameInput(), { target: { value: 'Tomin the Bold' } });

    const patch = mockPatch({ ...data, themeColor: '#123456' });
    await clickSave();
    const paths = patch.mock.calls[0][1].map((c) => c.path);
    expect(paths).toContain('characterName');
    expect(paths).not.toContain('themeColor');
  });

  it('while saving, the form is read-only and Cancel is disabled (nothing typed can be lost)', async () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);
    fireEvent.change(nameInput(), { target: { value: 'Tomin the Bold' } });

    const patch = vi.mocked(api.patchCharacterData);
    patch.mockReset();
    let resolvePatch!: (value: any) => void;
    patch.mockReturnValue(new Promise((resolve) => (resolvePatch = resolve)));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^\s*Save\s*$/ }));
    });

    expect(nameInput()).toBeDisabled();
    expect(xpInput()).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeDisabled();

    await act(async () => {
      resolvePatch({ character: makeCharacter({ ...data, characterName: 'Tomin the Bold' }), applied: ['characterName'], conflicts: [], status: 200 });
    });
    expect(dirty()).toBe('false');
  });

  it('values derived on open never overwrite other people\'s changes: a save sends only the user\'s field', async () => {
    const socket = createFakeSocket();
    const initial = {
      ...data,
      proficiencies: { armor: '', weapons: '', tools: '', languages: 'Common' },
      proficienciesAndLanguages: ['Common', 'Elvish'], // the GM added Elvish directly
      savingThrows: { strength: { proficient: false, bonus: 7 } }, // set by the GM, not the formula
      skills: { athletics: { proficient: false, expertise: false, bonus: 5 } },
    };
    render(<Harness socket={socket} initialData={initial} />);
    // Live GM/MCP changes to derived fields while the sheet is open.
    const gmData = {
      ...initial,
      proficienciesAndLanguages: ['Common', 'Elvish', 'Dwarvish'],
      skills: { athletics: { proficient: false, expertise: false, bonus: 6 } },
    };
    act(() => socket.emit(remote(gmData)));

    fireEvent.change(nameInput(), { target: { value: 'Tomin the Bold' } });
    const patch = mockPatch(gmData);
    await clickSave();

    expect(patch.mock.calls[0][1]).toEqual([{ path: 'characterName', base: 'Tomin', value: 'Tomin the Bold' }]);
  });

  it('a derived value whose input the user edited is saved with it (proficiencies → flat list, score → modifier)', async () => {
    const socket = createFakeSocket();
    const initial = {
      ...data,
      proficiencies: { armor: '', weapons: '', tools: '', languages: 'Common' },
      proficienciesAndLanguages: ['Common'],
    };
    render(<Harness socket={socket} initialData={initial} />);
    const scoreInput = (ability: string) =>
      screen.getByText(ability).parentElement!.querySelector('input') as HTMLInputElement;
    fireEvent.change(scoreInput('str'), { target: { value: '18' } });
    fireEvent.click(screen.getByRole('button', { name: /Features/ }));
    fireEvent.change(screen.getByPlaceholderText(/Common, Elvish/i), { target: { value: 'Common, Orc' } });

    const patch = mockPatch(initial);
    await clickSave();
    const changes = patch.mock.calls[0][1];
    expect(changes).toContainEqual({ path: 'stats.strength.score', base: 15, value: 18 });
    expect(changes).toContainEqual({ path: 'stats.strength.modifier', base: 2, value: 4 });
    expect(changes).toContainEqual({ path: 'proficiencies.languages', base: 'Common', value: 'Common, Orc' });
    expect(changes).toContainEqual({ path: 'proficienciesAndLanguages', base: ['Common'], value: ['Common', 'Orc'] });
  });
});
