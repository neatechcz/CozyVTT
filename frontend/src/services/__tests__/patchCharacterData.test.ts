import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../api';

const body = {
  character: { id: 'c1', data: { hp: { current: 3 } } },
  applied: [] as string[],
  conflicts: [{ path: 'hp.current', base: 5, current: 3, attempted: 4 }],
};

describe('api.patchCharacterData', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the changes to PATCH /api/characters/:id/data and returns 200 bodies with status', async () => {
    const patch = vi
      .spyOn((api as any).client, 'patch')
      .mockResolvedValue({ status: 200, data: { ...body, applied: ['xp'], conflicts: [] } });

    const changes = [{ path: 'experiencePoints', base: 10, value: 20 }];
    const result = await api.patchCharacterData('c1', changes);

    expect(patch).toHaveBeenCalledWith(
      '/api/characters/c1/data',
      { changes },
      expect.objectContaining({ validateStatus: expect.any(Function) }),
    );
    expect(result).toEqual({ ...body, applied: ['xp'], conflicts: [], status: 200 });
  });

  it('returns the 409 body instead of throwing', async () => {
    vi.spyOn((api as any).client, 'patch').mockResolvedValue({ status: 409, data: body });
    const result = await api.patchCharacterData('c1', []);
    expect(result).toEqual({ ...body, status: 409 });
  });

  it('accepts only 2xx and 409 as non-errors', async () => {
    const patch = vi.spyOn((api as any).client, 'patch').mockResolvedValue({ status: 200, data: body });
    await api.patchCharacterData('c1', []);
    const { validateStatus } = patch.mock.calls[0][2] as { validateStatus: (s: number) => boolean };
    expect(validateStatus(200)).toBe(true);
    expect(validateStatus(409)).toBe(true);
    expect(validateStatus(400)).toBe(false);
    expect(validateStatus(403)).toBe(false);
    expect(validateStatus(500)).toBe(false);
  });

  it('propagates other errors', async () => {
    const error = Object.assign(new Error('Bad'), { response: { status: 400, data: { validationErrors: [] } } });
    vi.spyOn((api as any).client, 'patch').mockRejectedValue(error);
    await expect(api.patchCharacterData('c1', [])).rejects.toBe(error);
  });
});
