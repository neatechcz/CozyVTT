import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage';

const mocks = vi.hoisted(() => ({
  getUserPreferences: vi.fn(),
  uploadAvatar: vi.fn(),
  refreshUser: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      displayName: 'Robin',
      email: 'robin@example.test',
      platformRole: 'USER',
      avatarUrl: null,
      bio: '',
    },
    logout: vi.fn(),
    refreshUser: mocks.refreshUser,
    changePassword: vi.fn(),
  }),
}));

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ appearance: null, applyUserPreferences: vi.fn() }),
}));

vi.mock('@/services/profile.service', () => ({
  profileService: {
    uploadAvatar: mocks.uploadAvatar,
    updateProfile: vi.fn(),
    deleteAccount: vi.fn(),
  },
}));

vi.mock('@/services/api', () => ({
  api: {
    getUserPreferences: mocks.getUserPreferences,
    updateUserPreferences: vi.fn(),
  },
}));

vi.mock('@/components/profile/MFASection', () => ({ default: () => null }));
vi.mock('@/components/appearance/ThemePicker', () => ({
  default: () => null,
  DEFAULT_CUSTOM_COLORS: {},
}));

function renderProfile() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ProfilePage />
    </MemoryRouter>,
  );
}

describe('ProfilePage avatar accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserPreferences.mockResolvedValue({});
    mocks.uploadAvatar.mockResolvedValue(undefined);
    mocks.refreshUser.mockResolvedValue(undefined);
    vi.stubGlobal('FileReader', class {
      result: string | null = null;
      onloadend: (() => void) | null = null;
      readAsDataURL() {
        this.result = 'data:image/png;base64,dGVzdA==';
        queueMicrotask(() => this.onloadend?.());
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the avatar picker from the keyboard-accessible button', async () => {
    const user = userEvent.setup();
    renderProfile();

    const trigger = screen.getByRole('button', { name: 'Change avatar' });
    const fileInput = screen.getByLabelText('Choose avatar image');
    const click = vi.spyOn(fileInput, 'click');
    trigger.focus();
    await user.keyboard('{Enter}');

    expect(click).toHaveBeenCalledTimes(1);
  });

  it('labels and traps the crop dialog, closes on Escape, and restores focus to its trigger', async () => {
    const user = userEvent.setup();
    renderProfile();

    const trigger = screen.getByRole('button', { name: 'Change avatar' });
    const fileInput = screen.getByLabelText('Choose avatar image');
    trigger.focus();
    fireEvent.change(fileInput, {
      target: { files: [new File(['avatar'], 'avatar.png', { type: 'image/png' })] },
    });

    const dialog = await screen.findByRole('dialog', { name: 'Crop Avatar' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const zoom = within(dialog).getByRole('slider', { name: 'Zoom' });
    await waitFor(() => expect(zoom).toHaveFocus());

    await user.keyboard('{Tab}');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(zoom).toHaveFocus();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Crop Avatar' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(mocks.uploadAvatar).not.toHaveBeenCalled();
  });
});
