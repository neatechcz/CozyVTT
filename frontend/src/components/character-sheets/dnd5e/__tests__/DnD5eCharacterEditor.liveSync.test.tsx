import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Character } from '@/types';
import { DnD5eCharacterEditor } from '../DnD5eCharacterEditor';
import { buildDnd5eFormData } from '../dnd5eFormData';
import { createCharacterFormStore } from '../../../../utils/characterFormStore';

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

const gm = { userId: 'gm', displayName: 'GM' };
const newStore = () => createCharacterFormStore(data, { normalize: buildDnd5eFormData, updatedAt: character.updatedAt });
const nameInput = () => screen.getByPlaceholderText('Character Name') as HTMLInputElement;

describe('DnD5eCharacterEditor form store', () => {
  it('without a store it edits a private one initialized from the character (unchanged standalone behaviour)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<DnD5eCharacterEditor character={character} onSave={onSave} onCancel={vi.fn()} />);
    expect(nameInput().value).toBe('Tomin');
    fireEvent.change(nameInput(), { target: { value: 'Tomin the Bold' } });
    expect(nameInput().value).toBe('Tomin the Bold');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^\s*Save\s*$/ }));
    });
    const saved = onSave.mock.calls[0][0];
    expect(saved.characterName).toBe('Tomin the Bold');
    expect(saved.themeColor).toBe('Classic Red');
    expect(saved.featuresAndTraits).toEqual([]);
    expect(saved.stats.dexterity.modifier).toBe(1);
  });

  it('shows remote changes applied to the store at once, keeping the active tab', () => {
    const store = newStore();
    render(<DnD5eCharacterEditor character={character} onSave={vi.fn()} onCancel={vi.fn()} formStore={store} />);

    fireEvent.click(screen.getByRole('button', { name: /Combat/ }));
    const currentHp = () =>
      screen.getByText('Current').parentElement!.querySelector('input') as HTMLInputElement;
    expect(currentHp().value).toBe('8');

    act(() => {
      store.applyRemote({ ...data, characterName: 'Remote', hp: { current: 2, maximum: 12, temporary: 0 } }, gm);
    });

    expect(currentHp().value).toBe('2');
    expect(screen.getByRole('button', { name: /Combat/ })).toBeInTheDocument();
  });

  it('typing is a user edit in the store; derived values are not', () => {
    const store = newStore();
    render(<DnD5eCharacterEditor character={character} onSave={vi.fn()} onCancel={vi.fn()} formStore={store} />);
    expect(store.getState().touched.size).toBe(0);

    fireEvent.change(nameInput(), { target: { value: 'Tomin the Bold' } });
    expect([...store.getState().touched]).toEqual(['characterName']);
    expect(store.getState().form.characterName).toBe('Tomin the Bold');
  });

  it('a remounted editor shows the store, not the (stale) character prop', () => {
    const store = newStore();
    const first = render(<DnD5eCharacterEditor character={character} onSave={vi.fn()} onCancel={vi.fn()} formStore={store} />);
    act(() => {
      store.applyRemote({ ...data, characterName: 'Remote' }, gm);
    });
    first.unmount();
    render(<DnD5eCharacterEditor character={character} onSave={vi.fn()} onCancel={vi.fn()} formStore={store} />);
    expect(nameInput().value).toBe('Remote');
  });

  it('unmounting discards unsaved edits in the store (resets are kept)', () => {
    const store = newStore();
    const view = render(<DnD5eCharacterEditor character={character} onSave={vi.fn()} onCancel={vi.fn()} formStore={store} />);
    fireEvent.change(nameInput(), { target: { value: 'Unsaved' } });
    expect(store.getState().touched.size).toBe(1);

    view.unmount();

    expect(store.getState().touched.size).toBe(0);
    expect(store.getState().form.characterName).toBe('Tomin');
  });

  it('save hands over the store form with the stored shape (parsed lists) without touching user fields', async () => {
    const store = newStore();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<DnD5eCharacterEditor character={character} onSave={onSave} onCancel={vi.fn()} formStore={store} />);
    fireEvent.click(screen.getByRole('button', { name: /Spells/ }));
    const cantrips = screen.getByPlaceholderText(/Fire Bolt/i) as HTMLTextAreaElement;
    fireEvent.change(cantrips, { target: { value: 'Light, Mage Hand' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^\s*Save\s*$/ }));
    });

    expect(onSave.mock.calls[0][0]).toBe(store.getState().form);
    expect(store.getState().form.spellcasting.cantrips).toEqual(['Light', 'Mage Hand']);
    expect([...store.getState().touched]).toEqual(['spellcasting.cantrips']);
  });
});
