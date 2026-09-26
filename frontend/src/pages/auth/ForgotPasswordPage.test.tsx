import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ForgotPasswordPage from './ForgotPasswordPage';

const mocks = vi.hoisted(() => ({
  forgotPassword: vi.fn(),
}));

vi.mock('@/services/auth.service', () => ({
  default: { forgotPassword: mocks.forgotPassword },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ authenticated: false }),
}));

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

async function submitEmail() {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'someone@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }));
  });
}

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clearly reports when password reset is unavailable', async () => {
    mocks.forgotPassword.mockResolvedValue({
      message: 'Password reset is not available. Contact your administrator.',
    });
    renderPage();

    await submitEmail();

    expect(await screen.findByRole('heading', { name: 'Password reset unavailable' })).toBeInTheDocument();
    expect(screen.getByText('Password reset is not available. Contact your administrator.')).toBeInTheDocument();
    expect(screen.queryByText('Check your inbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/we've sent a password reset link/i)).not.toBeInTheDocument();
  });

  it('keeps the generic response when the server has reset email enabled', async () => {
    mocks.forgotPassword.mockResolvedValue({
      message: 'If an account with that email exists, a password reset link has been sent.',
    });
    renderPage();

    await submitEmail();

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(screen.getByText(/If an account with that email address exists/)).toBeInTheDocument();
    expect(screen.queryByText('Password reset unavailable')).not.toBeInTheDocument();
  });

  it('keeps showing unexpected server errors in the submitted state', async () => {
    mocks.forgotPassword.mockRejectedValue({
      response: { data: { message: 'The auth service is temporarily unavailable.' } },
    });
    renderPage();

    await submitEmail();

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(screen.getByText('The auth service is temporarily unavailable.')).toBeInTheDocument();
  });
});
