import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AssetLibraryPage from './AssetLibraryPage';
import { AssetScope, AssetType, type Asset } from '@/types';

const mocks = vi.hoisted(() => ({
  listAssets: vi.fn(),
  patchAssetScope: vi.fn(),
  getAssetUrl: vi.fn(() => '/api/assets/asset-1/tokens'),
  getCampaigns: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'owner-1', platformRole: 'USER', globalAssetManager: false } }),
}));

vi.mock('@/services/api', () => ({
  api: {
    listAssets: mocks.listAssets,
    patchAssetScope: mocks.patchAssetScope,
    getAssetUrl: mocks.getAssetUrl,
  },
}));

vi.mock('@/services/campaign.service', () => ({
  default: { getCampaigns: mocks.getCampaigns },
}));

vi.mock('@/components/assets/AssetUploadModal', () => ({ default: () => null }));

const personalAsset: Asset = {
  id: 'asset-1',
  name: 'Alpha Audit Map',
  type: AssetType.MAP,
  scope: AssetScope.USER,
  uploadedById: 'owner-1',
  campaignId: null,
  filename: 'alpha.png',
  originalName: 'alpha.png',
  mimeType: 'image/png',
  fileSize: 1024,
  filePath: '/tmp/alpha.png',
  thumbnailPath: null,
  description: null,
  tags: ['audit'],
  createdAt: '2026-09-24T10:00:00.000Z',
};

let listedAsset: Asset;

function renderAssetLibraryPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AssetLibraryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AssetLibraryPage scope updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listedAsset = personalAsset;
    mocks.listAssets.mockImplementation(async () => ({
      assets: [listedAsset],
      pagination: { page: 1, limit: 24, total: 1, totalPages: 1 },
    }));
    mocks.patchAssetScope.mockImplementation(async (_id, scope, campaignId) => {
      listedAsset = {
        ...listedAsset,
        scope,
        campaignId: campaignId ?? null,
        campaign: campaignId ? { id: campaignId, name: 'Audit Campaign' } : null,
      };
      return { message: 'Asset moved', asset: listedAsset };
    });
    mocks.getCampaigns.mockResolvedValue([
      {
        id: 'campaign-1',
        name: 'Audit Campaign',
        ownerId: 'owner-1',
        memberships: [{ userId: 'owner-1', role: 'DM' }],
      },
    ]);
  });

  it('refreshes the library card after an asset moves to a campaign', async () => {
    const user = userEvent.setup();
    renderAssetLibraryPage();

    await screen.findByRole('heading', { name: 'Alpha Audit Map' });
    await user.click(screen.getByRole('button', { name: 'List view' }));
    await user.click(screen.getByTitle('View details'));

    const dialog = await screen.findByRole('dialog', { name: 'Alpha Audit Map' });
    await user.click(within(dialog).getByRole('button', { name: 'Campaign' }));
    await user.selectOptions(within(dialog).getByRole('combobox'), 'campaign-1');
    await user.click(within(dialog).getByRole('button', { name: 'Move to Campaign' }));

    await within(dialog).findByText('Asset moved successfully.');
    await waitFor(() => expect(mocks.listAssets).toHaveBeenCalledTimes(2));
    await user.click(within(dialog).getByRole('button', { name: 'Close asset details' }));

    const cardRow = screen.getByRole('heading', { name: 'Alpha Audit Map' }).parentElement?.parentElement;
    expect(cardRow).not.toBeNull();
    expect(within(cardRow as HTMLElement).getByText('CAMPAIGN')).toBeInTheDocument();
    expect(within(cardRow as HTMLElement).queryByText('Personal')).not.toBeInTheDocument();
  });
});
