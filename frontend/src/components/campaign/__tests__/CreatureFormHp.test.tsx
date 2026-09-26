import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatureTemplate, NpcStatBlock } from '@/types';
import { GameSystem } from '@/types';
import { CreatureForm } from '../CreatureLibrary';

const mocks = vi.hoisted(() => ({
  updateCreature: vi.fn(),
  createCreature: vi.fn(),
}));

vi.mock('@/services/api', () => ({
  default: {
    updateCreature: mocks.updateCreature,
    createCreature: mocks.createCreature,
    uploadAsset: vi.fn(),
  },
}));

vi.mock('@/contexts/CampaignContext', () => ({ useCampaign: () => ({ campaign: null }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ socket: null }) }));

const baseStatBlock: NpcStatBlock = {
  ac: 15,
  speed: '30 ft.',
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
  creatureType: 'Small humanoid (goblinoid)',
};

function creature(statBlock: NpcStatBlock): CreatureTemplate {
  return {
    id: 'c1',
    name: 'Goblin Copy',
    gameSystem: GameSystem.DND_5E,
    source: 'custom',
    challengeRating: '1/4',
    creatureType: 'Small humanoid (goblinoid)',
    alignment: 'neutral evil',
    imageUrl: null,
    statBlock,
    size: { width: 1, height: 1 },
    disposition: 'hostile',
    displayMode: 'pog',
    createdById: 'u1',
    campaignId: 'camp1',
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
  };
}

function renderForm(editing: CreatureTemplate | null) {
  const onEdited = vi.fn();
  const onCreated = vi.fn();
  render(
    <CreatureForm
      campaignId="camp1"
      gameSystem={GameSystem.DND_5E}
      editingCreature={editing}
      onCreated={onCreated}
      onEdited={onEdited}
      onCancel={vi.fn()}
    />,
  );
  return { onEdited, onCreated };
}

function savedStatBlock(mock: typeof mocks.updateCreature): NpcStatBlock {
  return mock.mock.calls[0][2].statBlock as NpcStatBlock;
}

describe('CreatureForm hit points', () => {
  beforeEach(() => {
    mocks.updateCreature.mockReset().mockImplementation(async (_c: string, _id: string, payload: unknown) => payload);
    mocks.createCreature.mockReset().mockImplementation(async (_c: string, payload: unknown) => payload);
  });

  it('keeps statBlock.hp when an edited creature is saved', async () => {
    renderForm(creature({ ...baseStatBlock, hp: { average: 7, formula: '2d6' } }));
    expect(screen.getByLabelText('Hit points average')).toHaveValue(7);
    expect(screen.getByLabelText('Hit dice formula')).toHaveValue('2d6');

    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mocks.updateCreature).toHaveBeenCalled());
    expect(savedStatBlock(mocks.updateCreature).hp).toEqual({ average: 7, formula: '2d6' });
  });

  it('saves an edited hp average and formula', async () => {
    renderForm(creature({ ...baseStatBlock, hp: { average: 7, formula: '2d6' } }));
    fireEvent.change(screen.getByLabelText('Hit points average'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Hit dice formula'), { target: { value: '3d6+2' } });

    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mocks.updateCreature).toHaveBeenCalled());
    expect(savedStatBlock(mocks.updateCreature).hp).toEqual({ average: 12, formula: '3d6+2' });
  });

  it('does not invent hp for a creature that had none', async () => {
    renderForm(creature(baseStatBlock));
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mocks.updateCreature).toHaveBeenCalled());
    expect(savedStatBlock(mocks.updateCreature)).not.toHaveProperty('hp');
  });

  it('stores hp entered for a new creature', async () => {
    renderForm(null);
    fireEvent.change(screen.getByPlaceholderText('e.g. Goblin Boss'), { target: { value: 'Bandit' } });
    fireEvent.change(screen.getByLabelText('Hit points average'), { target: { value: '11' } });
    fireEvent.click(screen.getByText('Create Creature'));
    await waitFor(() => expect(mocks.createCreature).toHaveBeenCalled());
    expect((mocks.createCreature.mock.calls[0][1].statBlock as NpcStatBlock).hp).toEqual({ average: 11 });
  });
});

describe('CreatureForm hit point validation', () => {
  beforeEach(() => {
    mocks.updateCreature.mockReset().mockImplementation(async (_c: string, _id: string, payload: unknown) => payload);
    mocks.createCreature.mockReset().mockImplementation(async (_c: string, payload: unknown) => payload);
  });

  it('shows an error instead of removing hp when the average is cleared', async () => {
    renderForm(creature({ ...baseStatBlock, hp: { average: 7, formula: '2d6' } }));
    fireEvent.change(screen.getByLabelText('Hit points average'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Hit dice formula'), { target: { value: '' } });

    fireEvent.click(screen.getByText('Save Changes'));
    expect(await screen.findByText('HP is required: enter a whole number of at least 1')).toBeInTheDocument();
    expect(mocks.updateCreature).not.toHaveBeenCalled();
  });

  it('rejects a decimal average instead of truncating it', async () => {
    renderForm(creature({ ...baseStatBlock, hp: { average: 7, formula: '2d6' } }));
    fireEvent.change(screen.getByLabelText('Hit points average'), { target: { value: '7.5' } });

    fireEvent.click(screen.getByText('Save Changes'));
    expect(await screen.findByText('HP must be a whole number')).toBeInTheDocument();
    expect(mocks.updateCreature).not.toHaveBeenCalled();
  });

  it('rejects hit dice without an average', async () => {
    renderForm(creature(baseStatBlock));
    fireEvent.change(screen.getByLabelText('Hit dice formula'), { target: { value: '2d6' } });

    fireEvent.click(screen.getByText('Save Changes'));
    expect(await screen.findByText('Enter the HP average for the HP dice')).toBeInTheDocument();
    expect(mocks.updateCreature).not.toHaveBeenCalled();
  });

  it('rejects a zero average for a new creature', async () => {
    renderForm(null);
    fireEvent.change(screen.getByPlaceholderText('e.g. Goblin Boss'), { target: { value: 'Bandit' } });
    fireEvent.change(screen.getByLabelText('Hit points average'), { target: { value: '0' } });

    fireEvent.click(screen.getByText('Create Creature'));
    expect(await screen.findByText('HP must be at least 1')).toBeInTheDocument();
    expect(mocks.createCreature).not.toHaveBeenCalled();
  });

  it('saves once the error is corrected', async () => {
    renderForm(creature({ ...baseStatBlock, hp: { average: 7, formula: '2d6' } }));
    fireEvent.change(screen.getByLabelText('Hit points average'), { target: { value: '7.5' } });
    fireEvent.click(screen.getByText('Save Changes'));
    expect(await screen.findByText('HP must be a whole number')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Hit points average'), { target: { value: '8' } });
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mocks.updateCreature).toHaveBeenCalled());
    expect(screen.queryByText('HP must be a whole number')).not.toBeInTheDocument();
    expect(savedStatBlock(mocks.updateCreature).hp).toEqual({ average: 8, formula: '2d6' });
  });
});

/** A duplicated SRD creature: every field the Open5e seed produces, plus extras the form never shows. */
const srdStatBlock: NpcStatBlock = {
  ac: 15,
  hp: { average: 7, formula: '2d6' },
  speed: '30 ft.',
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
  savingThrows: { dex: 4 },
  skills: { stealth: 6 },
  damageVulnerabilities: 'radiant',
  damageResistances: 'cold',
  damageImmunities: 'poison',
  conditionImmunities: 'poisoned',
  senses: 'darkvision 60 ft., passive Perception 9',
  languages: 'Common, Goblin',
  challengeRating: '1/4',
  xp: 50,
  traits: [{ name: 'Nimble Escape', description: 'Disengage or Hide as a bonus action.' }],
  actions: [
    { name: 'Scimitar', description: 'Melee Weapon Attack: +4 to hit.', attack_bonus: 4, damage_dice: '1d6' } as {
      name: string;
      description: string;
    },
  ],
  bonusActions: [{ name: 'Dash', description: 'Moves quickly.' }],
  reactions: [{ name: 'Redirect Attack', description: 'Swaps places with an ally.' }],
  legendaryActions: [{ name: 'Cackle', description: 'Frightens a creature.' }],
  creatureType: 'Small humanoid (goblinoid)',
  alignment: 'neutral evil',
  gameSystem: 'dnd5e',
  notes: 'Seeded from Open5e',
};

describe('CreatureForm keeps the whole stat block', () => {
  beforeEach(() => {
    mocks.updateCreature.mockReset().mockImplementation(async (_c: string, _id: string, payload: unknown) => payload);
  });

  it('saves an unchanged SRD copy without losing any field', async () => {
    renderForm(creature(srdStatBlock));
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mocks.updateCreature).toHaveBeenCalled());
    expect(savedStatBlock(mocks.updateCreature)).toEqual(srdStatBlock);
  });

  it('overwrites only the edited fields', async () => {
    renderForm(creature(srdStatBlock));
    fireEvent.change(screen.getByDisplayValue('15'), { target: { value: '17' } });
    fireEvent.change(screen.getByDisplayValue('Common, Goblin'), { target: { value: 'Common' } });

    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mocks.updateCreature).toHaveBeenCalled());
    expect(savedStatBlock(mocks.updateCreature)).toEqual({ ...srdStatBlock, ac: 17, languages: 'Common' });
  });

  it('removes a form field the user cleared but keeps the rest', async () => {
    renderForm(creature(srdStatBlock));
    fireEvent.change(screen.getByDisplayValue('cold'), { target: { value: '' } });

    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mocks.updateCreature).toHaveBeenCalled());
    const saved = savedStatBlock(mocks.updateCreature);
    expect(saved).not.toHaveProperty('damageResistances');
    expect(saved.savingThrows).toEqual({ dex: 4 });
    expect(saved.skills).toEqual({ stealth: 6 });
  });

  it('drops the CR-derived xp when the challenge rating changes', async () => {
    renderForm(creature(srdStatBlock));
    fireEvent.change(screen.getByDisplayValue('1/4'), { target: { value: '1' } });

    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mocks.updateCreature).toHaveBeenCalled());
    const saved = savedStatBlock(mocks.updateCreature);
    expect(saved.challengeRating).toBe('1');
    expect(saved).not.toHaveProperty('xp');
    expect(saved.skills).toEqual({ stealth: 6 });
  });
});
