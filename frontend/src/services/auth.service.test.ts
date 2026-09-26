import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authService } from './auth.service';

const apiMocks = vi.hoisted(() => ({
  forgotPassword: vi.fn(),
}));

vi.mock('./api', () => ({
  api: {
    forgotPassword: apiMocks.forgotPassword,
  },
}));

describe('AuthService forgot password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the server message so the page can report reset availability', async () => {
    const response = { message: 'Password reset is not available. Contact your administrator.' };
    apiMocks.forgotPassword.mockResolvedValue(response);

    await expect(authService.forgotPassword('admin@example.test')).resolves.toEqual(response);
    expect(apiMocks.forgotPassword).toHaveBeenCalledWith({ email: 'admin@example.test' });
  });
});
