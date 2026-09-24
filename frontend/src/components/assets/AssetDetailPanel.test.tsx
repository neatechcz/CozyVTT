import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AssetDetailPanel from './AssetDetailPanel';
import { AssetScope, AssetType, type Asset } from '@/types';

const mocks = vi.hoisted(() => ({
  getCampaigns: vi.fn(),
  getAssetUrl: vi.fn(() => '/api/assets/asset-1/tokens'),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'owner-1', platformRole: 'USER' } }),
}));

vi.mock('@/services/campaign.service', () => ({
  default: { getCampaigns: mocks.getCampaigns },
}));

vi.mock('@/services/api', () => ({
  api: { getAssetUrl: mocks.getAssetUrl },
}));

const asset = {
  id: 'asset-1',
  name: 'Goblin Token',
  type: AssetType.TOKEN,
  scope: AssetScope.USER,
  uploadedById: 'owner-1',
  createdAt: '2026-09-24T10:00:00.000Z',
  fileSize: 1024,
  mimeType: 'image/png',
  originalName: 'goblin.png',
  filename: 'goblin.png',
  tags: [],
} as unknown as Asset;

function PanelHost() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open asset details</button>
      {open && (
        <AssetDetailPanel
          asset={asset}
          onClose={() => setOpen(false)}
          onDelete={() => {}}
        />
      )}
    </>
  );
}

describe('AssetDetailPanel accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCampaigns.mockResolvedValue([]);
    mocks.getAssetUrl.mockReturnValue('/api/assets/asset-1/tokens');
  });

  it('traps focus in a labelled dialog and Escape closes it back to its trigger', async () => {
    const user = userEvent.setup();
    render(<PanelHost />);
    const trigger = screen.getByRole('button', { name: 'Open asset details' });

    trigger.focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: 'Goblin Token' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const closeButton = within(dialog).getByRole('button', { name: 'Close asset details' });
    await waitFor(() => expect(closeButton).toHaveFocus());

    const lastButton = within(dialog).getByRole('button', { name: 'Delete' });
    lastButton.focus();
    await user.keyboard('{Tab}');
    expect(closeButton).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Goblin Token' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('keeps the asset panel open when Escape dismisses its nested delete confirmation', async () => {
    const user = userEvent.setup();
    render(<PanelHost />);
    await user.click(screen.getByRole('button', { name: 'Open asset details' }));
    const panel = await screen.findByRole('dialog', { name: 'Goblin Token' });

    await user.click(within(panel).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Asset' });
    expect(confirm).toHaveAttribute('aria-modal', 'true');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete Asset' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Goblin Token' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Delete' })).toHaveFocus();
  });
});
