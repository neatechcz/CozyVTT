import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pathfinder2eCharacterDataSchema } from '../../../../../backend/src/validators/game-systems/pathfinder2e.schema';
import minimalPathfinder from '../../../../../Examples/Pathfinder_2e_character_minimal.json';
import { Pathfinder2eCharacterEditor } from './Pathfinder2eCharacterEditor';

const mocks = vi.hoisted(() => ({
  uploadAsset: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  api: { uploadAsset: mocks.uploadAsset },
}));

const minimalData = minimalPathfinder.character.data;

function makeCharacter(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aria-id',
    userId: 'player-id',
    campaignId: null,
    gameSystem: 'PATHFINDER_2E',
    name: minimalPathfinder.character.name,
    data: { ...minimalData, ...overrides },
    tokenImageUrl: null,
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
  };
}

function expectValidPathfinderSave(savedData: unknown) {
  const validation = pathfinder2eCharacterDataSchema.safeParse(savedData);
  expect(validation.success, validation.success ? undefined : JSON.stringify(validation.error.issues)).toBe(true);
}

describe('Pathfinder2eCharacterEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves an imported minimal character unchanged without null spellcasting', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <Pathfinder2eCharacterEditor
        character={makeCharacter()}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedData = onSave.mock.calls[0][0];

    expectValidPathfinderSave(savedData);
    expect(savedData).not.toHaveProperty('spellcasting');
    expect(savedData.characterName).toBe(minimalData.characterName);
    expect(savedData.ancestry).toBe(minimalData.ancestry);
  });

  it('saves an edit and token photo for a character without spellcasting', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    mocks.uploadAsset.mockResolvedValue({ message: 'Uploaded', asset: { id: 'pf2-photo' } });
    const { container } = render(
      <Pathfinder2eCharacterEditor
        character={makeCharacter({ background: 'Scout' })}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Player Name'), {
      target: { value: 'Luna' },
    });
    fireEvent.change(container.querySelector('#token-upload') as HTMLInputElement, {
      target: { files: [new File(['token'], 'aria.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedData = onSave.mock.calls[0][0];

    expectValidPathfinderSave(savedData);
    expect(savedData).not.toHaveProperty('spellcasting');
    expect(savedData.playerName).toBe('Luna');
    expect(savedData.background).toBe('Scout');
    expect(onSave).toHaveBeenCalledWith(savedData, true, '/api/assets/tokens/pf2-photo');
  });

  it('preserves spellcasting and other existing sheet data', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const slots = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [String(index + 1), {
        total: index === 0 ? 2 : 0,
        expended: index === 0 ? 1 : 0,
      }])
    );
    const spellcasting = {
      tradition: 'arcane',
      type: 'prepared',
      keyAttribute: 'intelligence',
      spellAttackBonus: { proficiencyRank: 'trained', itemBonus: 0, bonus: 3 },
      spellDC: { proficiencyRank: 'trained', itemBonus: 0, dc: 13 },
      cantrips: [{ rank: 1, name: 'Detect Magic', prepared: true }],
      slots,
      spells: [{ rank: 1, name: 'Magic Missile', prepared: true, ritual: false, heightened: false }],
      focusSpells: { focusPoints: { total: 1, current: 1 }, spells: [] },
      innateSpells: [{ rank: 1, name: 'Light', tradition: 'arcane', frequency: 'at will' }],
      rituals: [],
    };
    render(
      <Pathfinder2eCharacterEditor
        character={makeCharacter({ spellcasting, background: 'Scholar' })}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedData = onSave.mock.calls[0][0];

    expectValidPathfinderSave(savedData);
    expect(savedData.spellcasting).toEqual(spellcasting);
    expect(savedData.background).toBe('Scholar');
  });
});
