import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CombatState } from '@/types';
import InitiativeTracker from './InitiativeTracker';
import { useGameStore } from '@/stores/gameStore';

const mocks = vi.hoisted(() => ({
  registerState: vi.fn(),
  off: vi.fn(),
  requestState: vi.fn(),
  dash: vi.fn(),
}));

vi.mock('@/contexts/CampaignContext', () => ({
  useCampaign: () => ({ userRole: 'DM', currentMap: { id: 'map-1' } }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'dm' } }),
}));

vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocket: () => ({
    socket: {
      onInitiativeState: mocks.registerState,
      off: mocks.off,
      emitInitiativeRequestState: mocks.requestState,
      emitInitiativeDash: mocks.dash,
    },
  }),
}));

const combatState: CombatState = {
  active: true,
  round: 2,
  currentTokenId: 'hero',
  combatants: [{
    tokenId: 'hero', name: 'Mira', imageUrl: '', initiative: 16,
    hp: { current: 12, max: 12, temp: 0 }, type: 'player', disposition: 'friendly',
  }],
  movement: {
    tokenId: 'hero', turnId: 'turn-2-hero', speedFeet: 30, spentFeet: 10,
    dashBonusFeet: 0, dashUsed: false, diagonalStepsTaken: 0, remainingMovementFeet: 20,
  },
};

describe('InitiativeTracker movement', () => {
  let sendState: ((state: CombatState) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    useGameStore.getState().clearGameState();
    sendState = (state) => useGameStore.getState().setCombatState(state);
  });

  it('shows server movement speed, spent feet, and remaining feet for the active actor', () => {
    render(<InitiativeTracker />);
    act(() => sendState?.(combatState));

    expect(screen.getByText('Speed 30 ft')).toBeInTheDocument();
    expect(screen.getByText('10 ft spent')).toBeInTheDocument();
    expect(screen.getByText('20 ft remaining')).toBeInTheDocument();
  });

  it('sends Dash for the server-reported active actor', () => {
    render(<InitiativeTracker />);
    act(() => sendState?.(combatState));

    fireEvent.click(screen.getByRole('button', { name: 'Dash for Mira' }));

    expect(mocks.dash).toHaveBeenCalledWith({ tokenId: 'hero' });
  });

  it('keeps unresolved movement values visible as unknown', () => {
    render(<InitiativeTracker />);
    act(() => sendState?.({
      ...combatState,
      movement: {
        ...combatState.movement!,
        speedFeet: null,
        remainingMovementFeet: null,
      },
    }));

    expect(screen.getByText('Speed unknown')).toBeInTheDocument();
    expect(screen.getByText('Movement remaining unknown')).toBeInTheDocument();
  });
});
