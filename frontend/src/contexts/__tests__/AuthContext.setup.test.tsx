import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '../AuthContext';
import { authService } from '@/services/auth.service';
import type { User } from '@/types/user.types';

vi.mock('@/services/auth.service', () => ({
  authService: {
    getCurrentUser: vi.fn(),
  },
}));

const adminUser = {
  id: 'first-admin',
  email: 'admin@example.test',
  displayName: 'First Admin',
  platformRole: 'ADMIN',
  mustChangePassword: false,
} as User;

function AuthStateProbe() {
  const { authenticated, user, refreshUser } = useAuth();

  return (
    <div>
      <span data-testid="auth-state">{authenticated ? 'signed-in' : 'signed-out'}</span>
      <span data-testid="auth-user">{user?.email ?? 'none'}</span>
      <button onClick={() => void refreshUser()}>refresh session</button>
    </div>
  );
}

describe('AuthContext setup session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adopts the session created by setup when auth state was initially signed out', async () => {
    const getCurrentUser = vi.mocked(authService.getCurrentUser);
    getCurrentUser
      .mockRejectedValueOnce(new Error('Not authenticated'))
      .mockResolvedValueOnce(adminUser);

    render(
      <AuthProvider>
        <AuthStateProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-out'));
    fireEvent.click(screen.getByRole('button', { name: 'refresh session' }));

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in');
      expect(screen.getByTestId('auth-user')).toHaveTextContent(adminUser.email);
    });
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
  });
});
