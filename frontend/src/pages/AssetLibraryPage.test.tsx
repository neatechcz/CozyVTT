import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import AssetLibraryPage from './AssetLibraryPage';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1', platformRole: 'USER', globalAssetManager: false } }),
}));

vi.mock('@/hooks/queries', () => ({
  useAssetsQuery: () => ({
    data: { assets: [], pagination: { totalPages: 1, total: 0 } },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

function renderAssetLibraryPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AssetLibraryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AssetLibraryPage mobile accessibility', () => {
  it('labels header actions and every scope filter when their text is hidden', () => {
    renderAssetLibraryPage();

    const pageHeader = screen.getByRole('heading', { name: 'Asset Library' }).closest('.max-w-7xl') as HTMLElement;
    const header = within(pageHeader);

    expect(header.getByRole('button', { name: 'Back to Dashboard' })).toHaveAttribute('aria-label', 'Back to Dashboard');
    expect(header.getByRole('button', { name: 'Upload Asset' })).toHaveAttribute('aria-label', 'Upload Asset');

    for (const label of ['All Assets', 'Global', 'Personal', 'Campaign']) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-label', label);
    }
  });
});
