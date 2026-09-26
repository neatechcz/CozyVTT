import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignRole,
  CampaignStatus,
  PlatformRole,
  type Campaign,
  type CampaignMembership,
  type User,
} from '@/types';
import CampaignSettingsModal from '../CampaignSettingsModal';

const mocks = vi.hoisted(() => ({
  refreshCampaign: vi.fn(),
  showToast: vi.fn(),
  changeCampaignMemberRole: vi.fn(),
  removeCampaignMember: vi.fn(),
}));
let currentUser: User;

function makeUser(id: string, displayName: string): User {
  return {
    id,
    email: `${id}@example.test`,
    displayName,
    platformRole: PlatformRole.USER,
    globalAssetManager: false,
    mfaEnabled: false,
    avatarUrl: null,
    bio: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    lastLoginAt: null,
  };
}

const owner = makeUser('owner', 'Owner User');
const coDm = makeUser('co-dm', 'Co DM');
const player = makeUser('player', 'Player User');

function membership(user: User, role: CampaignRole): CampaignMembership {
  return {
    id: `membership-${user.id}`,
    campaignId: 'campaign-1',
    userId: user.id,
    role,
    characterIds: [],
    joinedAt: '2026-07-29T00:00:00.000Z',
    user,
  };
}

const campaign = {
  id: 'campaign-1',
  name: 'Multiple DM Campaign',
  description: null,
  ownerId: owner.id,
  gameSystem: null,
  status: CampaignStatus.ACTIVE,
  currentMapId: null,
  vibeSettings: { periods: [] },
  currentVibe: null,
  spiritLayerEnabled: false,
  spiritLayerStyle: 'wispy',
  chatCooldownEnabled: false,
  chatCooldownSeconds: 5,
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
  lastPlayedAt: null,
  memberships: [
    membership(owner, CampaignRole.DM),
    membership(coDm, CampaignRole.DM),
    membership(player, CampaignRole.PLAYER),
  ],
} satisfies Campaign;

vi.mock('@/contexts/CampaignContext', () => ({
  useCampaign: () => ({ campaign, refreshCampaign: mocks.refreshCampaign }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: currentUser }),
}));

vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

vi.mock('@/services/api', () => ({
  default: {
    changeCampaignMemberRole: mocks.changeCampaignMemberRole,
    removeCampaignMember: mocks.removeCampaignMember,
    exportCampaign: vi.fn(),
  },
}));

vi.mock('@/services/campaign.service', () => ({
  default: {
    updateCampaign: vi.fn(),
    deleteCampaign: vi.fn(),
  },
}));

vi.mock('../InvitePlayerModal', () => ({
  default: () => null,
}));

vi.mock('@/components/common/ConfirmDialog', () => ({
  default: () => null,
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: { children: ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
}));

function renderModal() {
  render(
    <MemoryRouter>
      <CampaignSettingsModal isOpen onClose={vi.fn()} />
    </MemoryRouter>,
  );
}

function openMembersTab() {
  fireEvent.click(screen.getByRole('button', { name: 'Members' }));
}

describe('CampaignSettingsModal multiple-DM controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.changeCampaignMemberRole.mockResolvedValue({ message: 'updated' });
    mocks.refreshCampaign.mockResolvedValue(undefined);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the owner label and independent role controls for multiple DMs', () => {
    currentUser = owner;
    renderModal();
    openMembersTab();

    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Owner User')).toBeInTheDocument();
    expect(screen.getByText('Co DM')).toBeInTheDocument();

    const coDmRole = screen.getByRole('combobox', { name: 'Role for Co DM' });
    expect(coDmRole).toHaveValue(CampaignRole.DM);
    expect(
      within(coDmRole).getByRole('option', { name: 'DM' }),
    ).toBeInTheDocument();
  });

  it('does not let a co-DM manage DM roles or delete the campaign', () => {
    currentUser = coDm;
    renderModal();
    openMembersTab();

    expect(
      screen.queryByRole('combobox', { name: 'Role for Owner User' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Role for Co DM' }),
    ).not.toBeInTheDocument();

    const playerRole = screen.getByRole('combobox', {
      name: 'Role for Player User',
    });
    expect(
      within(playerRole).queryByRole('option', { name: 'DM' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Danger Zone' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Campaign')).not.toBeInTheDocument();
  });

  it('changes a member role and refreshes authoritative campaign state', async () => {
    currentUser = owner;
    renderModal();
    openMembersTab();

    const playerRole = screen.getByRole('combobox', {
      name: 'Role for Player User',
    });
    fireEvent.change(playerRole, { target: { value: CampaignRole.DM } });
    expect(playerRole).toBeDisabled();

    await waitFor(() => {
      expect(mocks.changeCampaignMemberRole).toHaveBeenCalledWith(
        campaign.id,
        player.id,
        CampaignRole.DM,
      );
      expect(playerRole).not.toBeDisabled();
    });
    expect(mocks.refreshCampaign).toHaveBeenCalledOnce();
  });
});
