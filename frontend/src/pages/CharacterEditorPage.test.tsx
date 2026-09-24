import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character } from '@/types';
import CharacterEditorPage from './CharacterEditorPage';

const { getCharacterMock, updateCharacterMock, showToastMock, deleteAssetMock } = vi.hoisted(() => ({
  getCharacterMock: vi.fn(),
  updateCharacterMock: vi.fn(),
  showToastMock: vi.fn(),
  deleteAssetMock: vi.fn(),
}));

vi.mock('@/services/character.service', () => ({
  default: {
    getCharacter: getCharacterMock,
    updateCharacter: updateCharacterMock,
    exportCharacterJSON: vi.fn(),
  },
}));

vi.mock('@/services/campaign.service', () => ({
  default: { getCampaign: vi.fn() },
}));

vi.mock('@/services/api', () => ({
  api: { deleteAsset: deleteAssetMock },
}));

vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'user-1' };
  return { useAuth: () => ({ user }) };
});

vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

vi.mock('@/components/character-sheets/CharacterSheetRouter', async () => {
  const React = await import('react');

  return {
    CharacterSheetRouter: ({ character, onSave }: any) => {
      const [draft, setDraft] = React.useState(character.data.details);

      return (
        <section aria-label="Character sheet editor">
          <label>
            Character detail
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => void onSave({ ...character.data, details: draft })}
          >
            Save sheet
          </button>
          <button
            type="button"
            onClick={() => void onSave({ ...character.data, details: draft }, true, '/api/assets/tokens/uploaded-photo')}
          >
            Save with photo
          </button>
          <button
            type="button"
            onClick={() => void onSave({ ...character.data, details: draft }, true, '/api/assets/tokens/newer-photo')}
          >
            Save with newer photo
          </button>
          <button
            type="button"
            onClick={() => void onSave({ ...character.data, details: draft }, true, '')}
          >
            Clear token image
          </button>
        </section>
      );
    },
  };
});

const originalCharacter: Character = {
  id: 'character-1',
  userId: 'user-1',
  campaignId: null,
  gameSystem: null,
  name: 'Robin',
  data: { details: 'Original detail' } as unknown as Character['data'],
  tokenImageUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderEditor() {
  return render(
    <MemoryRouter
      initialEntries={['/characters/character-1/edit']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/characters/:id/edit" element={<CharacterEditorPage />} />
        <Route path="/characters" element={<div>Characters list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CharacterEditorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCharacterMock.mockResolvedValue(originalCharacter);
    deleteAssetMock.mockResolvedValue({ message: 'Asset deleted' });
  });

  it('keeps a rejected sheet save editable and allows correcting and retrying it', async () => {
    const validationFailure = {
      response: {
        data: {
          validationErrors: [
            { path: 'data.details', message: 'must be at least 3 characters' },
          ],
        },
      },
    };
    updateCharacterMock
      .mockRejectedValueOnce(validationFailure)
      .mockRejectedValueOnce(validationFailure)
      .mockResolvedValueOnce({
        ...originalCharacter,
        data: { details: 'Corrected detail' } as unknown as Character['data'],
      });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { unmount } = renderEditor();

    try {
      const detailInput = await screen.findByRole('textbox', { name: 'Character detail' });
      fireEvent.change(detailInput, { target: { value: 'x' } });
      expect(screen.queryByRole('button', { name: /^Save$/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save sheet' }));

      const saveError = await screen.findByRole('alert');
      expect(saveError).toHaveTextContent('data.details: must be at least 3 characters');
      expect(saveError).toHaveTextContent('Correct the listed values and try saving again');
      expect(screen.getByRole('heading', { name: 'Editing: Robin' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Failed to Load Character' })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Character detail' })).toHaveValue('x');
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry Save' })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: 'Retry Save' }));
      await waitFor(() => expect(updateCharacterMock).toHaveBeenCalledTimes(2));
      expect(updateCharacterMock.mock.calls[1][1].data).toEqual({ details: 'x' });
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry Save' })).toBeEnabled();

      fireEvent.change(screen.getByRole('textbox', { name: 'Character detail' }), {
        target: { value: 'Corrected detail' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save sheet' }));

      await waitFor(() => expect(updateCharacterMock).toHaveBeenCalledTimes(3));
      expect(updateCharacterMock.mock.calls[2][1].data).toEqual({
        details: 'Corrected detail',
      });
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: 'Editing: Robin' })).toBeInTheDocument();
      expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry Save' })).not.toBeInTheDocument();
    } finally {
      unmount();
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it.each([
    ['a new photo', 'Save with photo', '/api/assets/tokens/uploaded-photo'],
    ['a cleared photo', 'Clear token image', ''],
  ])('preserves the token image URL when retrying a failed save with %s', async (_description, action, tokenImageUrl) => {
    const characterWithPhoto = { ...originalCharacter, tokenImageUrl: '/api/tokens/old' };
    getCharacterMock.mockResolvedValue(characterWithPhoto);
    updateCharacterMock
      .mockRejectedValueOnce(new Error('Request failed'))
      .mockResolvedValueOnce({
        ...characterWithPhoto,
        tokenImageUrl: tokenImageUrl || null,
      });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { unmount } = renderEditor();

    try {
      await screen.findByRole('textbox', { name: 'Character detail' });
      expect(screen.queryByRole('button', { name: /^Save$/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: action }));
      await screen.findByRole('alert');

      expect(updateCharacterMock.mock.calls[0][1].tokenImageUrl).toBe(tokenImageUrl);
      expect(screen.getByRole('button', { name: 'Retry Save' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Retry Save' }));

      await waitFor(() => expect(updateCharacterMock).toHaveBeenCalledTimes(2));
      expect(updateCharacterMock.mock.calls[1][1]).toMatchObject({
        data: { details: 'Original detail' },
        tokenImageUrl,
      });
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry Save' })).not.toBeInTheDocument();
    } finally {
      unmount();
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it('deletes a newly uploaded photo after a failed save is abandoned, preserving the attached photo', async () => {
    const characterWithExistingPhoto = {
      ...originalCharacter,
      tokenImageUrl: '/api/assets/tokens/already-attached',
    };
    getCharacterMock.mockResolvedValue(characterWithExistingPhoto);
    updateCharacterMock.mockRejectedValueOnce({
      response: { status: 400, data: { message: 'Validation failed' } },
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { unmount } = renderEditor();

    try {
      await screen.findByRole('textbox', { name: 'Character detail' });
      fireEvent.click(screen.getByRole('button', { name: 'Save with photo' }));
      await screen.findByRole('alert');
      expect(deleteAssetMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Back to characters' }));
      fireEvent.click(screen.getByRole('button', { name: 'Leave' }));

      await waitFor(() => expect(deleteAssetMock).toHaveBeenCalledTimes(1));
      expect(deleteAssetMock).toHaveBeenCalledWith('uploaded-photo');
      expect(deleteAssetMock).not.toHaveBeenCalledWith('already-attached');
    } finally {
      unmount();
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it('keeps a failed photo upload through immediate retry success', async () => {
    const characterWithExistingPhoto = {
      ...originalCharacter,
      tokenImageUrl: '/api/assets/tokens/already-attached',
    };
    getCharacterMock.mockResolvedValue(characterWithExistingPhoto);
    updateCharacterMock
      .mockRejectedValueOnce({
        response: { status: 400, data: { message: 'Validation failed' } },
      })
      .mockResolvedValueOnce({
        ...characterWithExistingPhoto,
        tokenImageUrl: '/api/assets/tokens/uploaded-photo',
      });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { unmount } = renderEditor();

    try {
      await screen.findByRole('textbox', { name: 'Character detail' });
      fireEvent.click(screen.getByRole('button', { name: 'Save with photo' }));
      await screen.findByRole('alert');
      expect(deleteAssetMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Retry Save' }));
      await waitFor(() => expect(updateCharacterMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

      expect(updateCharacterMock.mock.calls[1][1].tokenImageUrl).toBe('/api/assets/tokens/uploaded-photo');
      expect(deleteAssetMock).not.toHaveBeenCalled();
    } finally {
      unmount();
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it('deletes the older failed upload when a newer uploaded photo supersedes it', async () => {
    updateCharacterMock
      .mockRejectedValueOnce({
        response: { status: 400, data: { message: 'First validation failed' } },
      })
      .mockRejectedValueOnce({
        response: { status: 400, data: { message: 'Second validation failed' } },
      })
      .mockResolvedValueOnce({
        ...originalCharacter,
        tokenImageUrl: '/api/assets/tokens/newer-photo',
      });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { unmount } = renderEditor();

    try {
      await screen.findByRole('textbox', { name: 'Character detail' });
      fireEvent.click(screen.getByRole('button', { name: 'Save with photo' }));
      await screen.findByRole('alert');
      expect(deleteAssetMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Save with newer photo' }));
      await waitFor(() => expect(updateCharacterMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(deleteAssetMock).toHaveBeenCalledWith('uploaded-photo'));
      expect(deleteAssetMock).not.toHaveBeenCalledWith('newer-photo');
      expect(screen.getByRole('button', { name: 'Retry Save' })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: 'Retry Save' }));
      await waitFor(() => expect(updateCharacterMock).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

      expect(updateCharacterMock.mock.calls[2][1].tokenImageUrl).toBe('/api/assets/tokens/newer-photo');
      expect(deleteAssetMock).toHaveBeenCalledTimes(1);
      expect(deleteAssetMock).toHaveBeenCalledWith('uploaded-photo');
    } finally {
      unmount();
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it('does not delete a retained photo while a retry is still in flight', async () => {
    const characterWithExistingPhoto = {
      ...originalCharacter,
      tokenImageUrl: '/api/assets/tokens/already-attached',
    };
    getCharacterMock.mockResolvedValue(characterWithExistingPhoto);

    let finishRetry!: (character: Character) => void;
    updateCharacterMock
      .mockRejectedValueOnce({
        response: { status: 400, data: { message: 'Validation failed' } },
      })
      .mockImplementationOnce(() => new Promise<Character>((resolve) => {
        finishRetry = resolve;
      }));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { unmount } = renderEditor();

    try {
      await screen.findByRole('textbox', { name: 'Character detail' });
      fireEvent.click(screen.getByRole('button', { name: 'Save with photo' }));
      await screen.findByRole('alert');
      fireEvent.click(screen.getByRole('button', { name: 'Retry Save' }));
      await waitFor(() => expect(updateCharacterMock).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByRole('button', { name: 'Back to characters' }));
      fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
      expect(deleteAssetMock).not.toHaveBeenCalled();

      finishRetry({
        ...characterWithExistingPhoto,
        tokenImageUrl: '/api/assets/tokens/uploaded-photo',
      });
      await waitFor(() => expect(screen.getByText('Characters list')).toBeInTheDocument());
      expect(deleteAssetMock).not.toHaveBeenCalled();
    } finally {
      unmount();
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });
});
