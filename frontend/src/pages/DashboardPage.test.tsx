import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from './DashboardPage';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    logout: vi.fn(),
    user: { id: 'user-1', displayName: 'A Person With a Long Display Name', platformRole: 'USER' },
  }),
}));

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ mascotUrl: '/mascot.svg' }),
}));

vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@/hooks/queries', () => ({
  queryKeys: { campaigns: ['campaigns'], characters: ['characters'] },
  useCampaignsQuery: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useCharactersQuery: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  usePendingInvitationsQuery: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
}));

function renderDashboardPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('DashboardPage mobile accessibility', () => {
  it('gives the icon-only quick link buttons accessible names', () => {
    renderDashboardPage();

    expect(screen.getByRole('button', { name: 'Manage characters' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View asset library' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import campaign' })).toBeInTheDocument();
  });
});
