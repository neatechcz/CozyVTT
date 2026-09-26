import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../AuthContext';
import { useCharactersQuery } from '@/hooks/queries';
import { queryClient } from '@/lib/queryClient';
import { PlatformRole } from '@/types/user.types';
import type { User } from '@/types/user.types';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  getCharacters: vi.fn(),
  activePlayer: 'A' as 'A' | 'B',
}));

vi.mock('@/services/auth.service', () => ({
  authService: {
    getCurrentUser: mocks.getCurrentUser,
    login: mocks.login,
    logout: mocks.logout,
  },
}));

vi.mock('@/services/character.service', () => ({
  default: {
    getCharacters: mocks.getCharacters,
  },
}));

const playerA = {
  id: 'player-a',
  email: 'a@example.test',
  displayName: 'Player A',
  platformRole: PlatformRole.USER,
  globalAssetManager: false,
  mfaEnabled: false,
  avatarUrl: null,
  bio: null,
  createdAt: '',
  updatedAt: '',
  lastLoginAt: null,
} as User;

const playerB = {
  id: 'player-b',
  email: 'b@example.test',
  displayName: 'Player B',
  platformRole: PlatformRole.USER,
  globalAssetManager: false,
  mfaEnabled: false,
  avatarUrl: null,
  bio: null,
  createdAt: '',
  updatedAt: '',
  lastLoginAt: null,
} as User;

function CharacterRoster() {
  const { data: characters = [] } = useCharactersQuery();

  return (
    <ul aria-label="Characters">
      {characters.map((character) => <li key={character.id}>{character.name}</li>)}
    </ul>
  );
}

function AuthenticatedCharacterApp() {
  const { authenticated, user, login, logout } = useAuth();

  if (!authenticated) {
    return <button onClick={() => void login('b@example.test', 'password')}>Log in as Player B</button>;
  }

  return (
    <main>
      <span data-testid="current-user">{user?.id}</span>
      <CharacterRoster />
      <button onClick={() => void logout()}>Log out</button>
    </main>
  );
}

describe('character query cache across account changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    mocks.activePlayer = 'A';
    mocks.getCurrentUser.mockResolvedValue(playerA);
    mocks.login.mockImplementation(async () => ({
      user: playerB,
      mustChangePassword: false,
    }));
    mocks.logout.mockResolvedValue(undefined);
    mocks.getCharacters.mockImplementation(async () => mocks.activePlayer === 'A'
      ? [{ id: 'character-a', name: 'Audit Character A' }]
      : [{ id: 'character-b', name: 'Player B Character' }]);
  });

  it('does not expose Player A character data to Player B after logout and login', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AuthenticatedCharacterApp />
        </AuthProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByText('Audit Character A')).toBeInTheDocument();
    await waitFor(() => expect(mocks.getCharacters).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('button', { name: 'Log in as Player B' })).toBeInTheDocument();

    mocks.activePlayer = 'B';
    fireEvent.click(screen.getByRole('button', { name: 'Log in as Player B' }));

    await waitFor(() => expect(screen.getByTestId('current-user')).toHaveTextContent('player-b'));
    expect(screen.queryByText('Audit Character A')).not.toBeInTheDocument();
    expect(await screen.findByText('Player B Character')).toBeInTheDocument();
    expect(mocks.getCharacters).toHaveBeenCalledTimes(2);
  });
});
