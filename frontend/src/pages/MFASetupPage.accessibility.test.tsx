import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MFASetupPage from './MFASetupPage';

const mocks = vi.hoisted(() => ({ setupMFA: vi.fn(), completeMFASetup: vi.fn() }));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authenticated: true,
    setupMFA: mocks.setupMFA,
    completeMFASetup: mocks.completeMFASetup,
  }),
}));

describe('MFASetupPage accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setupMFA.mockResolvedValue({ qrCodeUrl: 'data:image/png;base64,', secret: 'TESTSECRET' });
    mocks.completeMFASetup.mockResolvedValue({ backupCodes: [] });
  });

  it('associates the Verification Code label with the one-time-code input', async () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <MFASetupPage />
      </MemoryRouter>,
    );

    const input = await screen.findByLabelText('Verification Code');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
  });
});
