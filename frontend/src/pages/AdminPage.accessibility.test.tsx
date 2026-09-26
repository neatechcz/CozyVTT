import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPage from './AdminPage';

const mocks = vi.hoisted(() => ({
  getStats: vi.fn(),
  getUsers: vi.fn(),
  getSettings: vi.fn(),
  getConfig: vi.fn(),
  createUser: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', displayName: 'Admin', email: 'admin@example.test', platformRole: 'ADMIN' },
  }),
}));

vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ refreshAppearance: vi.fn() }) }));
vi.mock('@/services/admin.service', () => ({
  adminService: {
    getStats: mocks.getStats,
    getUsers: mocks.getUsers,
    getSettings: mocks.getSettings,
    getConfig: mocks.getConfig,
    createUser: mocks.createUser,
  },
}));
vi.mock('@/services/api', () => ({ api: {} }));
vi.mock('@/components/appearance/ThemePicker', () => ({ default: () => null }));

const settings = {
  id: 'settings-1',
  instanceName: 'CozyVTT',
  timezone: 'UTC',
  allowRegistration: false,
  requireAdminApproval: true,
  themeId: 'cozy-default',
  customThemeColors: null,
  fontId: 'default',
  customLogoUrl: null,
  customFaviconUrl: null,
  customMascotUrl: null,
};

const createdUser = {
  id: 'user-2',
  email: 'new@example.test',
  displayName: 'New User',
  platformRole: 'USER',
  globalAssetManager: false,
  mfaEnabled: false,
  avatarUrl: null,
  bio: null,
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
  lastLoginAt: null,
  isApproved: true,
};

function renderAdmin() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AdminPage />
    </MemoryRouter>,
  );
}

describe('AdminPage accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStats.mockResolvedValue({
      userCount: 1,
      campaignCount: 0,
      activeCampaignCount: 0,
      totalStorageBytes: 0,
      activeSessionCount: 0,
      sessionCount: 0,
      characterCount: 0,
      mapCount: 0,
      assetBreakdown: [],
    });
    mocks.getUsers.mockResolvedValue([]);
    mocks.getSettings.mockResolvedValue(settings);
    mocks.getConfig.mockResolvedValue(null);
    mocks.createUser.mockReset();
  });

  it('exposes the Create User overlay as a dialog and closes on Escape with focus restored', async () => {
    const user = userEvent.setup();
    renderAdmin();

    await user.click(screen.getByRole('tab', { name: 'Users' }));
    const trigger = await screen.findByRole('button', { name: 'Create User' });
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Create User' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toHaveFocus());
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toHaveFocus();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create User' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('keeps the dialog open when Escape is pressed while user creation is pending', async () => {
    const user = userEvent.setup();
    let resolveCreate!: (result: { user: typeof createdUser; temporaryPassword: string }) => void;
    mocks.createUser.mockReturnValue(new Promise(resolve => { resolveCreate = resolve; }));
    renderAdmin();

    await user.click(screen.getByRole('tab', { name: 'Users' }));
    await user.click(await screen.findByRole('button', { name: 'Create User' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create User' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toHaveFocus());
    await user.type(within(dialog).getByLabelText(/Email/), 'new@example.test');
    await user.click(within(dialog).getByRole('button', { name: 'Create User' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create User' })).toBeDisabled());

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Create User' })).toBeInTheDocument();

    await act(async () => resolveCreate({ user: createdUser, temporaryPassword: 'temporary-secret' }));
    expect(await within(dialog).findByText('User created successfully!')).toBeInTheDocument();
  });

  it('keeps the one-time password visible when Escape is pressed after creation', async () => {
    const user = userEvent.setup();
    mocks.createUser.mockResolvedValue({ user: createdUser, temporaryPassword: 'temporary-secret' });
    renderAdmin();

    await user.click(screen.getByRole('tab', { name: 'Users' }));
    await user.click(await screen.findByRole('button', { name: 'Create User' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create User' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toHaveFocus());
    await user.type(within(dialog).getByLabelText(/Email/), 'new@example.test');
    await user.click(within(dialog).getByRole('button', { name: 'Create User' }));
    expect(await within(dialog).findByText('User created successfully!')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.getByRole('dialog', { name: 'Create User' })).toBeInTheDocument();
    expect(screen.getByText('temporary-secret')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Create User' })).not.toBeInTheDocument();
  });

  it('names the settings switches and moves tab focus and selection with arrow keys', async () => {
    const user = userEvent.setup();
    renderAdmin();

    const dashboardTab = screen.getByRole('tab', { name: 'Dashboard' });
    dashboardTab.focus();
    await user.keyboard('{ArrowRight}');
    const usersTab = screen.getByRole('tab', { name: 'Users' });
    expect(usersTab).toHaveFocus();
    expect(usersTab).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByRole('switch', { name: 'Allow Public Registration' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Require Admin Approval' })).toBeInTheDocument();
  });

  it('lets the tab list wrap within its available width', async () => {
    renderAdmin();

    const tabList = screen.getByRole('tablist', { name: 'Admin tabs' });
    expect(tabList).toHaveClass('flex-wrap');
    expect(tabList).toHaveClass('max-w-full');
    await screen.findByText('Healthy');
  });
});
