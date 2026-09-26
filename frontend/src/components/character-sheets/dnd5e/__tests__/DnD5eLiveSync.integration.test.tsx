/**
 * Editor + wrapper + hook together: the handshake between
 * useLiveCharacterSync and DnD5eCharacterEditor.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Character } from '@/types';
import { useLiveCharacterSync } from '@/hooks/useLiveCharacterSync';
import { api } from '@/services/api';
import { DnD5eCharacterSheet } from '../DnD5eCharacterSheet';

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
  afterReport,
  before,
}: {
  socket: ReturnType<typeof createFakeSocket>;
  /** Runs after each local report reaches the hook (e.g. to inject a remote event) */
  afterReport?: (origin: string) => void;
  /** Rendered before the sheet, so its passive effects run before the editor's */
  before?: (sync: Sync) => ReactNode;
}) {
  const [character, setCharacter] = useState(() => makeCharacter(data));
  const sync = useLiveCharacterSync({ character, socket, isDnd5e: true, onServerCharacter: setCharacter });
  return (
    <>
      <span data-testid="dirty">{String(sync.isDirty)}</span>
      <ul data-testid="resets">
        {sync.resets.map((r) => (
          <li key={`${r.path}-${r.at}`}>{`${r.path}|${JSON.stringify(r.mine)}|${JSON.stringify(r.theirs)}|${r.author.displayName}`}</li>
        ))}
      </ul>
      {before?.(sync)}
      <DnD5eCharacterSheet
        character={character}
        mode="edit"
        onSave={async (saveData) => {
          await sync.save(saveData);
        }}
        externalData={sync.externalData}
        externalBase={sync.externalBase}
        externalDataVersion={sync.externalDataVersion}
        onLocalChange={(formData, origin, resets, appliedVersion) => {
          sync.reportLocalChange(formData, origin, resets, appliedVersion);
          afterReport?.(origin);
        }}
        onDiscardLocalChanges={sync.discardLocalChanges}
      />
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

describe('D&D 5e live sync (editor + hook)', () => {
  // Kept first: earlier tests in this file change React's scheduling state
  // enough that the pre-fix bug did not reproduce after them.
  it('(b) remote 1 → keystroke → remote 2 before remote 1 is rendered: saving never reverts remote 1', async () => {
    const socket = createFakeSocket();
    let injected = false;
    const remote1 = { ...data, hp: { current: 3, maximum: 12, temporary: 0 } };
    const remote2 = { ...remote1, experiencePoints: 400 };
    render(
      <Harness
        socket={socket}
        afterReport={(origin) => {
          // The keystroke's report arrives before the editor rendered remote 1;
          // remote 2 lands right then.
          if (origin === 'user' && !injected) {
            injected = true;
            socket.emit(remote(remote2, '2026-09-26T00:00:06.000Z'));
          }
        }}
      />,
    );

    act(() => {
      socket.emit(remote(remote1));
      fireEvent.change(nameInput(), { target: { value: 'Tomin the Bold' } });
    });
    expect(injected).toBe(true);

    expect(nameInput().value).toBe('Tomin the Bold');
    expect(xpInput().value).toBe('400');
    expect(resetLines()).toEqual([]);

    const patch = vi.mocked(api.patchCharacterData);
    patch.mockReset();
    patch.mockImplementation(async (_id, changes) => ({
      character: makeCharacter({ ...remote2, characterName: 'Tomin the Bold' }),
      applied: changes.map((c) => c.path),
      conflicts: [],
      status: 200,
    }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^\s*Save\s*$/ }));
    });

    expect(patch).toHaveBeenCalledTimes(1);
    const changes = patch.mock.calls[0][1];
    expect(changes).toContainEqual({ path: 'characterName', base: 'Tomin', value: 'Tomin the Bold' });
    const paths = changes.map((c) => c.path);
    expect(paths).not.toContain('hp.current');
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

  it('(a) typing into a field a simultaneous remote update changed shows the remote value and a reset entry', () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);

    act(() => {
      socket.emit(remote({ ...data, experiencePoints: 150 }));
      fireEvent.change(xpInput(), { target: { value: '120' } });
    });

    expect(xpInput().value).toBe('150');
    expect(resetLines()).toEqual(['experiencePoints|120|150|GM']);
    expect(dirty()).toBe('false');
  });

  it.each([
    ['a different field is kept', 'name', undefined],
    ['the same field is reported as a reset', 'xp', 'experiencePoints|120|150|GM'],
  ])('(c) window B: a keystroke queued before the rebase runs — %s', (_label, field, expectedReset) => {
    const socket = createFakeSocket();
    function KeystrokeWhenVersionChanges({ version }: { version: number }) {
      useEffect(() => {
        if (version === 0) return;
        // Queued in the same (default) lane just before the editor's
        // adoption effect queues its rebase — processed together.
        if (field === 'name') callReactOnChange(nameInput(), 'Typed');
        else callReactOnChange(xpInput(), '120');
      }, [version]);
      return null;
    }
    render(
      <Harness socket={socket} before={(sync) => <KeystrokeWhenVersionChanges version={sync.externalDataVersion} />} />,
    );

    act(() => socket.emit(remote({ ...data, experiencePoints: 150 })));

    expect(xpInput().value).toBe('150');
    if (field === 'name') {
      expect(nameInput().value).toBe('Typed');
      expect(dirty()).toBe('true');
      expect(resetLines()).toEqual([]);
    } else {
      expect(resetLines()).toEqual([expectedReset]);
    }
  });

  it('typing after a remote update is tracked as a user edit', () => {
    const socket = createFakeSocket();
    render(<Harness socket={socket} />);
    act(() => socket.emit(remote({ ...data, experiencePoints: 150 })));
    expect(dirty()).toBe('false');

    fireEvent.change(nameInput(), { target: { value: 'Typed' } });
    expect(dirty()).toBe('true');
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
});
