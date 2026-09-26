/**
 * Editor + wrapper + hook together: the handshake between
 * useLiveCharacterSync and DnD5eCharacterEditor.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Character } from '@/types';
import { useLiveCharacterSync } from '@/hooks/useLiveCharacterSync';
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

function Harness({ socket }: { socket: ReturnType<typeof createFakeSocket> }) {
  const [character, setCharacter] = useState(() => makeCharacter(data));
  const sync = useLiveCharacterSync({ character, socket, isDnd5e: true, onServerCharacter: setCharacter });
  return (
    <>
      <span data-testid="dirty">{String(sync.isDirty)}</span>
      <DnD5eCharacterSheet
        character={character}
        mode="edit"
        onSave={vi.fn()}
        externalData={sync.externalData}
        externalBase={sync.externalBase}
        externalDataVersion={sync.externalDataVersion}
        onLocalChange={sync.reportLocalChange}
        onDiscardLocalChanges={sync.discardLocalChanges}
      />
    </>
  );
}

const nameInput = () => screen.getByPlaceholderText('Character Name') as HTMLInputElement;
const xpInput = () =>
  screen.getByText('Experience Points').parentElement!.querySelector('input') as HTMLInputElement;
const dirty = () => screen.getByTestId('dirty').textContent;

function remote(characterData: object) {
  return {
    characterId: 'char-1',
    character: { ...makeCharacter(characterData), updatedAt: '2026-09-26T00:00:05.000Z' },
    userId: 'gm',
    changedPaths: ['experiencePoints'],
    updatedBy: { userId: 'gm', displayName: 'GM' },
  };
}

describe('D&D 5e live sync (editor + hook)', () => {
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
