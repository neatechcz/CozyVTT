import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character } from '@/types';
import CharacterEditorPage from './CharacterEditorPage';

const { getCharacterMock, updateCharacterMock, showToastMock } = vi.hoisted(() => ({
  getCharacterMock: vi.fn(),
  updateCharacterMock: vi.fn(),
  showToastMock: vi.fn(),
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
            onClick={() => void onSave({ ...character.data, details: draft }, true, '/api/tokens/new')}
          >
            Save with photo
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
      </Routes>
    </MemoryRouter>,
  );
}

describe('CharacterEditorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCharacterMock.mockResolvedValue(originalCharacter);
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
      fireEvent.click(screen.getByRole('button', { name: 'Save sheet' }));

      const saveError = await screen.findByRole('alert');
      expect(saveError).toHaveTextContent('data.details: must be at least 3 characters');
      expect(saveError).toHaveTextContent('Correct the listed values and try saving again');
      expect(screen.getByRole('heading', { name: 'Editing: Robin' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Failed to Load Character' })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Character detail' })).toHaveValue('x');
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(updateCharacterMock).toHaveBeenCalledTimes(2));
      expect(updateCharacterMock.mock.calls[1][1].data).toEqual({ details: 'x' });
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

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
      expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled();
    } finally {
      unmount();
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it.each([
    ['a new photo', 'Save with photo', '/api/tokens/new'],
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
      fireEvent.click(screen.getByRole('button', { name: action }));
      await screen.findByRole('alert');

      expect(updateCharacterMock.mock.calls[0][1].tokenImageUrl).toBe(tokenImageUrl);
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

      await waitFor(() => expect(updateCharacterMock).toHaveBeenCalledTimes(2));
      expect(updateCharacterMock.mock.calls[1][1]).toMatchObject({
        data: { details: 'Original detail' },
        tokenImageUrl,
      });
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    } finally {
      unmount();
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });
});
