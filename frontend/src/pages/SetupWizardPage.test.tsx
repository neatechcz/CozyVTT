import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SetupWizardPage from './SetupWizardPage';

const mocks = vi.hoisted(() => ({
  checkSetupStatus: vi.fn(),
  initializeSetup: vi.fn(),
  refreshUser: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/services/setup.service', () => ({
  setupService: {
    checkSetupStatus: mocks.checkSetupStatus,
    initializeSetup: mocks.initializeSetup,
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ refreshUser: mocks.refreshUser }),
}));

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ mascotUrl: '' }),
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => mocks.navigate,
}));

describe('SetupWizardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkSetupStatus.mockResolvedValue({
      setupCompleted: false,
      hasUsers: false,
      needsSetup: true,
    });
    mocks.initializeSetup.mockResolvedValue({ message: 'Setup completed', user: {} });
    mocks.refreshUser.mockResolvedValue(undefined);
  });

  it('submits the reviewed instance name, timezone, and registration setting', async () => {
    render(<SetupWizardPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    fireEvent.change(await screen.findByLabelText('Display Name'), {
      target: { value: 'Audit Admin' },
    });
    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'admin@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'StrongSetupPass1!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'StrongSetupPass1!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.change(await screen.findByLabelText('Instance Name'), {
      target: { value: 'Supplement Audit' },
    });
    fireEvent.change(screen.getByLabelText('Timezone'), {
      target: { value: 'Europe/Prague' },
    });
    fireEvent.click(screen.getByLabelText('Enable Public Registration'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Supplement Audit')).toBeInTheDocument();
    expect(screen.getByText('Europe/Prague')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /complete setup/i }));

    await waitFor(() => expect(mocks.initializeSetup).toHaveBeenCalledWith({
      email: 'admin@example.test',
      password: 'StrongSetupPass1!',
      displayName: 'Audit Admin',
      instanceName: 'Supplement Audit',
      timezone: 'Europe/Prague',
      allowRegistration: true,
    }));
    expect(mocks.refreshUser).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/dashboard');
  });
});
