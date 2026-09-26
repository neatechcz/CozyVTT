import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DiceRoller from './DiceRoller';

const diceRollerMocks = vi.hoisted(() => ({
  socket: {
    isConnected: vi.fn(() => true),
    emitDiceRoll: vi.fn(),
    onDiceRolled: vi.fn(),
    onDiceRolledSecret: vi.fn(),
    onDiceHistoryCleared: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
    emitClearDiceHistory: vi.fn(),
  },
  user: { id: 'player-b', displayName: 'Player B' },
  userRole: 'PLAYER',
  campaign: null as any,
}));

vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ socket: diceRollerMocks.socket }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: diceRollerMocks.user }),
}));

vi.mock('@/contexts/CampaignContext', () => ({
  useCampaign: () => ({
    userRole: diceRollerMocks.userRole,
    campaign: diceRollerMocks.campaign,
  }),
}));

const campaign = {
  id: 'campaign-1',
  status: 'ACTIVE',
  characters: [
    { id: 'player-a-character', userId: 'player-a', campaignId: 'campaign-1', name: 'Player A' },
    { id: 'player-b-character', userId: 'player-b', campaignId: 'campaign-1', name: 'Player B' },
    { id: 'npc-character', userId: 'dm-1', campaignId: 'campaign-1', name: 'Goblin' },
  ],
  memberships: [
    { userId: 'player-a', role: 'PLAYER', characterIds: ['player-a-character'] },
    { userId: 'player-b', role: 'PLAYER', characterIds: ['player-b-character'] },
    { userId: 'dm-1', role: 'DM', characterIds: [] },
  ],
};

function submitRoll() {
  fireEvent.change(screen.getByPlaceholderText('e.g., 2d6+3, 1d20+5, 4d6kh3'), {
    target: { value: '1d20' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Roll' }));
}

describe('DiceRoller character attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    diceRollerMocks.userRole = 'PLAYER';
    diceRollerMocks.user = { id: 'player-b', displayName: 'Player B' };
    diceRollerMocks.campaign = campaign;
  });

  it('lets players choose only an owned or assigned character by ID', () => {
    render(<DiceRoller />);

    const characterSelect = screen.getByLabelText('Character');
    expect(characterSelect.tagName).toBe('SELECT');
    expect(Array.from((characterSelect as HTMLSelectElement).options).map((option) => option.value)).toEqual([
      '',
      'player-b-character',
    ]);
    expect(screen.queryByRole('textbox', { name: 'Character' })).not.toBeInTheDocument();

    fireEvent.change(characterSelect, { target: { value: 'player-b-character' } });
    submitRoll();

    const payload = diceRollerMocks.socket.emitDiceRoll.mock.calls[0][0];
    expect(payload).toMatchObject({ expression: '1d20', characterId: 'player-b-character' });
    expect(payload).not.toHaveProperty('characterName');
  });

  it('allows a player to roll without attributing the roll to a character', () => {
    render(<DiceRoller />);

    submitRoll();

    const payload = diceRollerMocks.socket.emitDiceRoll.mock.calls[0][0];
    expect(payload).toMatchObject({ expression: '1d20' });
    expect(payload).not.toHaveProperty('characterId');
    expect(payload).not.toHaveProperty('characterName');
  });

  it('lets a DM enter an arbitrary NPC label', () => {
    diceRollerMocks.userRole = 'DM';
    diceRollerMocks.user = { id: 'dm-1', displayName: 'Dungeon Master' };
    render(<DiceRoller />);

    const characterInput = screen.getByPlaceholderText('Character');
    expect(characterInput.tagName).toBe('INPUT');
    fireEvent.change(characterInput, { target: { value: 'Ancient Dragon' } });
    submitRoll();

    const payload = diceRollerMocks.socket.emitDiceRoll.mock.calls[0][0];
    expect(payload).toMatchObject({ expression: '1d20', characterName: 'Ancient Dragon' });
    expect(payload).not.toHaveProperty('characterId');
  });
});
