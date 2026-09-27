import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('explains and saves the Inspiration checkbox', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<DnD5eCharacterEditor character={makeNonSpellcaster()} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('Inspirace (2014)')).not.toBeChecked();
    expect(screen.getByText(/Před hodem.*výhodu/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Inspirace (2014)'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].inspiration).toBe(true);
  });

  it('shows Czech proficiencies in editable categories and preserves other training on save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const character = makeNonSpellcaster();
    character.data = { ...character.data, proficienciesAndLanguages: [
      'Záchranné hody na Moudrost',
      'Všechny zbroje',
      'Štíty',
      'Jednoduché zbraně',
      'Rapíry',
      'Kovářské nářadí',
      'Obecná řeč',
      'Trpasličština',
      'Historie',
    ] } as Character['data'];
    render(<DnD5eCharacterEditor character={character} onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Features' }));
    expect(screen.getByPlaceholderText('Light Armor, Medium Armor, Shields')).toHaveValue('Všechny zbroje, Štíty');
    expect(screen.getByPlaceholderText('Simple Weapons, Martial Weapons, or specific weapons (Daggers, Longswords, Shortbows)')).toHaveValue('Jednoduché zbraně, Rapíry');
    expect(screen.getByPlaceholderText("Thieves' Tools, Smith's Tools, Calligrapher's Supplies, Musical Instruments, Vehicles (Land/Water)")).toHaveValue('Kovářské nářadí');
    expect(screen.getByPlaceholderText('Common, Elvish, Dwarvish, Draconic')).toHaveValue('Obecná řeč, Trpasličština');
    expect(screen.getByPlaceholderText('Saving throws, skills, and other training')).toHaveValue('Záchranné hody na Moudrost, Historie');

    fireEvent.change(screen.getByPlaceholderText('Light Armor, Medium Armor, Shields'), {
      target: { value: 'Lehké zbroje, Štíty' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].proficienciesAndLanguages).toEqual([
      'Lehké zbroje', 'Štíty', 'Jednoduché zbraně', 'Rapíry', 'Kovářské nářadí',
      'Obecná řeč', 'Trpasličština', 'Záchranné hody na Moudrost', 'Historie',
    ]);
  });

  it('saves dated food and water intake with a numeric exhaustion level', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<DnD5eCharacterEditor character={makeNonSpellcaster()} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Combat' }));
    fireEvent.change(screen.getByLabelText('Last resolved day'), { target: { value: '8. Mlžníku' } });
    fireEvent.change(screen.getByLabelText('Food on resolved day (lb)'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('Water on resolved day (gallons)'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('Exhaustion level'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      survival: { lastResolvedDay: '8. Mlžníku', foodTodayPounds: 0.5,
        waterTodayGallons: 0.5, exhaustionLevel: 2 },
      conditions: expect.arrayContaining(['exhausted']),
    });
  });
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

  it('preserves a legacy proficiencies array when editing one category', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const character = makeNonSpellcaster();
    const { proficienciesAndLanguages: _ignored, ...legacyData } = character.data as any;
    character.data = {
      ...legacyData,
      proficiencies: ['Light Armor', 'Simple Weapons', 'Common'],
    };

    render(
      <DnD5eCharacterEditor
        character={character}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Features' }));
    const armorField = screen.getByPlaceholderText('Light Armor, Medium Armor, Shields');
    expect(armorField).toHaveValue('Light Armor');
    fireEvent.change(armorField, { target: { value: 'Light Armor, Heavy Armor' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedData = onSave.mock.calls[0][0];

    const validation = dnd5eCharacterDataSchema.safeParse(savedData);
    expect(validation.success, validation.success ? undefined : JSON.stringify(validation.error.issues)).toBe(true);
    expect(savedData.proficienciesAndLanguages).toEqual(expect.arrayContaining([
      'Light Armor',
      'Heavy Armor',
      'Simple Weapons',
      'Common',
    ]));
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

  it('saves a partial spell slot edit for a non-spellcaster with a named spell', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DnD5eCharacterEditor
        character={makeNonSpellcaster()}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Spells' }));
    const levelOne = within(screen.getByText('Level 1').parentElement as HTMLElement);
    fireEvent.change(levelOne.getAllByRole('spinbutton')[0], { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add Spell' }));
    fireEvent.change(screen.getByPlaceholderText('Spell Name'), {
      target: { value: 'Magic Missile' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedData = onSave.mock.calls[0][0];

    expect(savedData.spellcasting.slots).toEqual({ '1': { total: 1, expended: 0 } });
    expect(savedData.spellcasting.spells).toEqual([
      { level: 1, name: 'Magic Missile', prepared: false, ritual: false, concentration: false },
    ]);
    const validation = dnd5eCharacterDataSchema.safeParse(savedData);
    expect(validation.success, validation.success ? undefined : JSON.stringify(validation.error.issues)).toBe(true);
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
