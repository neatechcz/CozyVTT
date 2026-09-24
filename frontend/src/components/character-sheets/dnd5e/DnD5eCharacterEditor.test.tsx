import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { dnd5eCharacterDataSchema } from '../../../../../backend/src/validators/game-systems/dnd5e.schema';
import { GameSystem, type Character } from '../../../types';
import DnD5eCharacterEditor from './DnD5eCharacterEditor';

const mocks = vi.hoisted(() => ({
  uploadAsset: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  api: { uploadAsset: mocks.uploadAsset },
}));

const originalProficiencies = [
  'Light Armor',
  'Medium Armor',
  'Shields',
  'Simple Weapons',
  'Martial Weapons',
  'Smith’s Tools',
  'Vehicles (land)',
  'Common',
  'Dwarvish',
  'Saving Throws: Strength',
  'Saving Throws: Constitution',
];

function makeNonSpellcaster(): Character {
  return {
    id: 'robin-id',
    userId: 'lukas-id',
    campaignId: 'campaign-id',
    gameSystem: GameSystem.DND_5E,
    name: 'Robin',
    data: {
      characterName: 'Robin',
      class: 'Fighter',
      level: 1,
      race: 'Elf',
      proficiencyBonus: 2,
      stats: {
        strength: { score: 16, modifier: 3 },
        dexterity: { score: 14, modifier: 2 },
        constitution: { score: 14, modifier: 2 },
        intelligence: { score: 10, modifier: 0 },
        wisdom: { score: 12, modifier: 1 },
        charisma: { score: 8, modifier: -1 },
      },
      savingThrows: {
        strength: { proficient: false, bonus: 3 },
        dexterity: { proficient: false, bonus: 2 },
        constitution: { proficient: false, bonus: 2 },
        intelligence: { proficient: false, bonus: 0 },
        wisdom: { proficient: false, bonus: 1 },
        charisma: { proficient: false, bonus: -1 },
      },
      hp: { maximum: 10, current: 10, temporary: 0 },
      proficienciesAndLanguages: originalProficiencies,
    },
    tokenImageUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('DnD5eCharacterEditor', () => {
  it('preserves uncategorized legacy proficiencies when one category is edited', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DnD5eCharacterEditor
        character={makeNonSpellcaster()}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Features' }));
    fireEvent.change(screen.getByPlaceholderText('Light Armor, Medium Armor, Shields'), {
      target: { value: 'Light Armor, Heavy Armor' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedData = onSave.mock.calls[0][0];

    const validation = dnd5eCharacterDataSchema.safeParse(savedData);
    expect(validation.success, validation.success ? undefined : JSON.stringify(validation.error.issues)).toBe(true);
    expect(savedData.proficienciesAndLanguages).toEqual(expect.arrayContaining([
      'Light Armor',
      'Heavy Armor',
      'Saving Throws: Strength',
      'Saving Throws: Constitution',
    ]));
    expect(savedData.proficienciesAndLanguages).not.toContain('Medium Armor');
    expect(savedData.proficienciesAndLanguages).not.toContain('Shields');
  });

  it('saves a normal field edit for a non-spellcaster with valid data and existing proficiencies', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DnD5eCharacterEditor
        character={makeNonSpellcaster()}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Player Name'), {
      target: { value: 'Lukáš' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedData = onSave.mock.calls[0][0];

    const validation = dnd5eCharacterDataSchema.safeParse(savedData);
    expect(validation.success, validation.success ? undefined : JSON.stringify(validation.error.issues)).toBe(true);
    expect(savedData.spellcasting).toBeUndefined();
    expect(savedData.playerName).toBe('Lukáš');
    expect(savedData.proficienciesAndLanguages).toEqual(originalProficiencies);
  });

  it('saves a token image for a non-spellcaster with schema-valid character data', async () => {
    mocks.uploadAsset.mockResolvedValue({ asset: { id: 'new-token-id' } });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <DnD5eCharacterEditor
        character={makeNonSpellcaster()}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    const image = new File(['portrait'], 'robin.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('#token-upload')!, {
      target: { files: [image] },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [savedData, showToast, tokenImageUrl] = onSave.mock.calls[0];

    expect(mocks.uploadAsset).toHaveBeenCalledTimes(1);
    const validation = dnd5eCharacterDataSchema.safeParse(savedData);
    expect(validation.success, validation.success ? undefined : JSON.stringify(validation.error.issues)).toBe(true);
    expect(savedData.spellcasting).toBeUndefined();
    expect(savedData.proficienciesAndLanguages).toEqual(originalProficiencies);
    expect(showToast).toBe(true);
    expect(tokenImageUrl).toBe('/api/assets/tokens/new-token-id');
  });
});
