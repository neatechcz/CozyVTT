import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Character } from '@/types';
import CharacterEditorPage from '../CharacterEditorPage';

// The standalone editor sits outside the campaign's WebSocketProvider: for a
// D&D 5e character in a campaign it opens its own quiet connection (no
// "has joined the campaign" chat message) to receive character.updated.

const mocks = vi.hoisted(() => ({
  getCharacter: vi.fn(),
  getCampaign: vi.fn(),
  user: { id: 'owner', displayName: 'Owner' },
  socket: {
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(),
    getCampaignId: vi.fn(),
  },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@/services/character.service', () => ({
  default: { getCharacter: mocks.getCharacter, updateCharacter: vi.fn(), exportCharacterJSON: vi.fn() },
}));
vi.mock('@/services/campaign.service', () => ({ default: { getCampaign: mocks.getCampaign } }));
vi.mock('@/services/socket', () => ({ socketClient: mocks.socket, default: mocks.socket }));
vi.mock('@/services/api', () => {
  const api = { patchCharacterData: vi.fn(), getCharacter: vi.fn(), updateCharacter: vi.fn(), uploadAsset: vi.fn() };
  return { api, default: api };
});
vi.mock('@/components/character-sheets/CharacterSheetRouter', () => ({
  CharacterSheetRouter: () => <div>sheet</div>,
}));

const character: Character = {
  id: 'char-1',
  userId: 'owner',
  campaignId: 'camp-1',
  gameSystem: 'DND_5E' as Character['gameSystem'],
  name: 'Tomin',
  data: { characterName: 'Tomin', hp: { current: 8, maximum: 12, temporary: 0 } } as unknown as Character['data'],
  tokenImageUrl: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
};

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={['/characters/char-1/edit']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/characters/:id/edit" element={<CharacterEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function characterUpdatedHandler() {
  const call = mocks.socket.on.mock.calls.find(([event]) => event === 'character.updated');
  return call?.[1] as ((payload: unknown) => void) | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 'owner', displayName: 'Owner' };
  mocks.getCharacter.mockResolvedValue(character);
  mocks.getCampaign.mockResolvedValue({ id: 'camp-1', name: 'Klenba', memberships: [] });
  mocks.socket.connect.mockResolvedValue(undefined);
  mocks.socket.isConnected.mockReturnValue(false);
  mocks.socket.getCampaignId.mockReturnValue(null);
});

describe('CharacterEditorPage live socket', () => {
  it('connects quietly to the character campaign and applies character.updated', async () => {
    renderPage();
    await screen.findByText('Editing: Tomin');

    await waitFor(() => expect(characterUpdatedHandler()).toBeDefined());
    expect(mocks.socket.connect).toHaveBeenCalledTimes(1);
    expect(mocks.socket.connect).toHaveBeenCalledWith('camp-1', { quiet: true });

    act(() => {
      characterUpdatedHandler()!({
        characterId: 'char-1',
        character: { ...character, name: 'Tomin Renamed', updatedAt: '2026-09-26T01:00:00.000Z' },
        userId: 'dm',
        changedPaths: ['hp.current'],
        updatedBy: { userId: 'dm', displayName: 'DM' },
      });
    });
    expect(screen.getByText('Editing: Tomin Renamed')).toBeInTheDocument();
  });

  it('disconnects on unmount the connection it opened itself', async () => {
    const { unmount } = renderPage();
    await waitFor(() => expect(characterUpdatedHandler()).toBeDefined());

    unmount();

    expect(mocks.socket.off).toHaveBeenCalledWith('character.updated', characterUpdatedHandler());
    expect(mocks.socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('reuses a socket already connected to that campaign and leaves it connected', async () => {
    mocks.socket.isConnected.mockReturnValue(true);
    mocks.socket.getCampaignId.mockReturnValue('camp-1');

    const { unmount } = renderPage();
    await waitFor(() => expect(characterUpdatedHandler()).toBeDefined());
    expect(mocks.socket.connect).not.toHaveBeenCalled();

    unmount();
    expect(mocks.socket.disconnect).not.toHaveBeenCalled();
  });

  it('opens no socket for a character without a campaign', async () => {
    mocks.getCharacter.mockResolvedValue({ ...character, campaignId: null });

    renderPage();
    await screen.findByText('Editing: Tomin');

    expect(mocks.socket.connect).not.toHaveBeenCalled();
    expect(mocks.socket.on).not.toHaveBeenCalled();
  });

  it('opens no socket for other game systems', async () => {
    mocks.getCharacter.mockResolvedValue({ ...character, gameSystem: 'CALL_OF_CTHULHU_7E' });

    renderPage();
    await screen.findByText('Editing: Tomin');

    expect(mocks.socket.connect).not.toHaveBeenCalled();
    expect(mocks.socket.on).not.toHaveBeenCalled();
  });

  it('opens no socket when the user may not edit the character', async () => {
    mocks.user = { id: 'stranger', displayName: 'Stranger' };

    renderPage();
    await screen.findByText('Permission Denied');

    expect(mocks.socket.connect).not.toHaveBeenCalled();
  });

  it('keeps editing without live updates when the connection is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.socket.connect.mockRejectedValue(new Error('Not a member of this campaign'));

    const { unmount } = renderPage();
    await screen.findByText('Editing: Tomin');
    await waitFor(() => expect(warn).toHaveBeenCalled());

    expect(characterUpdatedHandler()).toBeUndefined();
    expect(screen.getByText('sheet')).toBeInTheDocument();

    unmount();
    // It started that connection attempt, so it cleans it up
    expect(mocks.socket.disconnect).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
