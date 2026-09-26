import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../api';

const character = { id: 'c1', data: { hp: { current: 3 } }, updatedAt: '2026-09-26T00:05:00.000Z' };
const LOADED = '2026-09-26T00:00:00.000Z';

describe('api.updateCharacterIfUnchanged', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PUTs the update with expectedUpdatedAt and returns the saved character with status 200', async () => {
    const put = vi
      .spyOn((api as any).client, 'put')
      .mockResolvedValue({ status: 200, data: { message: 'Character updated successfully', character } });

    const result = await api.updateCharacterIfUnchanged('c1', { data: { hp: { current: 3 } } as any }, LOADED);

    expect(put).toHaveBeenCalledWith(
      '/api/characters/c1',
      { data: { hp: { current: 3 } }, expectedUpdatedAt: LOADED },
      expect.objectContaining({ validateStatus: expect.any(Function) }),
    );
    expect(result).toEqual({ status: 200, character });
  });

  it('returns the 409 body (the current character) instead of throwing', async () => {
    vi.spyOn((api as any).client, 'put').mockResolvedValue({
      status: 409,
      data: { error: 'Conflict', message: 'Character changed since it was loaded', character },
    });

    const result = await api.updateCharacterIfUnchanged('c1', { data: {} as any }, LOADED);

    expect(result).toEqual({ status: 409, character });
  });

  it('accepts only 2xx and 409 as non-errors', async () => {
    const put = vi.spyOn((api as any).client, 'put').mockResolvedValue({ status: 200, data: { character } });
    await api.updateCharacterIfUnchanged('c1', { name: 'X' }, LOADED);
    const { validateStatus } = put.mock.calls[0][2] as { validateStatus: (s: number) => boolean };
    expect(validateStatus(200)).toBe(true);
    expect(validateStatus(409)).toBe(true);
    expect(validateStatus(400)).toBe(false);
    expect(validateStatus(403)).toBe(false);
    expect(validateStatus(503)).toBe(false);
  });

  it('propagates other errors', async () => {
    const error = Object.assign(new Error('Bad'), { response: { status: 400, data: { validationErrors: [] } } });
    vi.spyOn((api as any).client, 'put').mockRejectedValue(error);
    await expect(api.updateCharacterIfUnchanged('c1', { name: 'X' }, LOADED)).rejects.toBe(error);
  });
});
