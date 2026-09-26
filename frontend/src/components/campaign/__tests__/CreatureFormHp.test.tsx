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
