import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Character } from '@/types';
import { DnD5eCharacterEditor } from '../DnD5eCharacterEditor';

vi.mock('../../../../services/api', () => ({ api: { uploadAsset: vi.fn() } }));

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

const character: Character = {
  id: 'char-1',
  userId: 'owner',
  campaignId: 'camp-1',
  gameSystem: 'DND_5E' as Character['gameSystem'],
  name: 'Tomin',
  data: data as unknown as Character['data'],
  tokenImageUrl: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
};

function renderEditor(onLocalChange = vi.fn()) {
  const props = { character, onSave: vi.fn(), onCancel: vi.fn(), onLocalChange };
  const utils = render(<DnD5eCharacterEditor {...props} externalDataVersion={0} />);
  const rerenderWith = (externalData: object | undefined, externalDataVersion: number) =>
    utils.rerender(
      <DnD5eCharacterEditor {...props} externalData={externalData} externalDataVersion={externalDataVersion} />,
    );
  return { ...utils, rerenderWith, onLocalChange };
}

const nameInput = () => screen.getByPlaceholderText('Character Name') as HTMLInputElement;
const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1];

describe('DnD5eCharacterEditor live sync', () => {
  it('reports the initial form as a system change and typing as a user change', () => {
    const { onLocalChange } = renderEditor();
    expect(onLocalChange).toHaveBeenCalled();
    expect(onLocalChange.mock.calls[0][1]).toBe('system');
    expect(onLocalChange.mock.calls[0][0].characterName).toBe('Tomin');

    fireEvent.change(nameInput(), { target: { value: 'Tomin the Bold' } });

    const [reported, origin] = lastCall(onLocalChange);
    expect(origin).toBe('user');
    expect(reported.characterName).toBe('Tomin the Bold');
  });

  it('replaces the form when externalDataVersion changes, keeping the active tab', () => {
    const { rerenderWith, onLocalChange } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /Combat/ }));
    const currentHp = () =>
      screen.getByText('Current').parentElement!.querySelector('input') as HTMLInputElement;
    expect(currentHp().value).toBe('8');

    rerenderWith({ ...data, characterName: 'Remote', hp: { current: 2, maximum: 12, temporary: 0 } }, 1);

    // Still on the Combat tab, now showing the external values
    expect(currentHp().value).toBe('2');
    expect(nameInput().value).toBe('Remote');
    const [reported, origin] = lastCall(onLocalChange);
    expect(origin).toBe('system');
    expect(reported.hp.current).toBe(2);
  });

  it('does not re-apply external data for the same version', () => {
    const { rerenderWith } = renderEditor();
    const external = { ...data, characterName: 'Remote' };
    rerenderWith(external, 1);
    fireEvent.change(nameInput(), { target: { value: 'Typed after' } });

    rerenderWith(external, 1);
    expect(nameInput().value).toBe('Typed after');
  });

  it('a rebase over a form that differs only by system changes is not tagged as a user edit', () => {
    const onLocalChange = vi.fn();
    const props = { character, onSave: vi.fn(), onCancel: vi.fn(), onLocalChange };
    const { rerender } = render(<DnD5eCharacterEditor {...props} externalDataVersion={0} />);
    // The form differs from externalBase (e.g. a derived value not reported
    // yet) but the user typed nothing.
    const staleBase = { ...data, speed: 99 };
    rerender(
      <DnD5eCharacterEditor
        {...props}
        externalBase={staleBase}
        externalData={{ ...staleBase, experiencePoints: 150 }}
        externalDataVersion={1}
      />,
    );
    const [reported, origin, resets, appliedVersion] = lastCall(onLocalChange);
    expect(reported.experiencePoints).toBe(150);
    expect(origin).toBe('system');
    expect(resets).toBeUndefined();
    expect(appliedVersion).toBe(1);
  });

  it('ignores the external data present at mount (no stale overwrite on remount)', () => {
    const onLocalChange = vi.fn();
    render(
      <DnD5eCharacterEditor
        character={character}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        onLocalChange={onLocalChange}
        externalData={{ ...data, characterName: 'Stale' }}
        externalDataVersion={4}
      />,
    );
    expect(nameInput().value).toBe('Tomin');
  });
});
