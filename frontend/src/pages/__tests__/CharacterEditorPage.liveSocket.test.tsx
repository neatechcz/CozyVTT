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
  apiGetCharacter: vi.fn(),
  user: { id: 'owner', displayName: 'Owner' },
  lifecycle: new Set<(event: string, detail?: { error?: string }) => void>(),
  socket: {
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(),
    getCampaignId: vi.fn(),
    getSocket: vi.fn(),
    onLifecycle: vi.fn(),
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
  const api = { patchCharacterData: vi.fn(), getCharacter: mocks.apiGetCharacter, updateCharacter: vi.fn(), uploadAsset: vi.fn() };
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

const OFFLINE = 'Živé změny nejsou dostupné — změny ostatních se zobrazí po obnovení spojení.';
const SESSION_EXPIRED = 'Přihlášení vypršelo — přihlaste se znovu.';

/** The currently subscribed character.updated listener (latest on(), not yet off()) */
function characterUpdatedHandler() {
  const ons = mocks.socket.on.mock.calls.filter(([event]) => event === 'character.updated');
  const offs = new Set(mocks.socket.off.mock.calls.filter(([event]) => event === 'character.updated').map(([, cb]) => cb));
  const live = ons.map(([, cb]) => cb).filter((cb) => !offs.has(cb));
  return live[live.length - 1] as ((payload: unknown) => void) | undefined;
}

function lifecycle(
  event: 'replaced' | 'authenticated' | 'disconnected' | 'failed',
  detail?: { error?: string },
) {
  act(() => {
    for (const listener of [...mocks.lifecycle]) {
      if (detail) listener(event, detail);
      else listener(event);
    }
  });
}

function remoteRename(name: string, updatedAt: string) {
  act(() => {
    characterUpdatedHandler()!({
      characterId: 'char-1',
      character: { ...character, name, updatedAt },
      userId: 'dm',
      changedPaths: ['characterName'],
      updatedBy: { userId: 'dm', displayName: 'DM' },
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 'owner', displayName: 'Owner' };
  mocks.getCharacter.mockResolvedValue(character);
  mocks.getCampaign.mockResolvedValue({ id: 'camp-1', name: 'Klenba', memberships: [] });
  mocks.socket.connect.mockResolvedValue(undefined);
  mocks.socket.isConnected.mockReturnValue(false);
  mocks.socket.getCampaignId.mockReturnValue(null);
  mocks.socket.getSocket.mockReturnValue(null);
  mocks.lifecycle.clear();
  mocks.socket.onLifecycle.mockImplementation((listener: (event: string, detail?: { error?: string }) => void) => {
    mocks.lifecycle.add(listener);
    return () => mocks.lifecycle.delete(listener);
  });
  mocks.apiGetCharacter.mockResolvedValue({ character });
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
    const handler = characterUpdatedHandler();

    unmount();

    expect(mocks.socket.off).toHaveBeenCalledWith('character.updated', handler);
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

  it('after a failed connect, listens on the socket socket.io keeps retrying and catches up once it joins', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.socket.connect.mockRejectedValue(new Error('xhr poll error'));
    // The client still holds the socket for this campaign; socket.io retries it
    mocks.socket.getCampaignId.mockReturnValue('camp-1');
    mocks.socket.getSocket.mockReturnValue({});

    renderPage();
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(screen.getByText('sheet')).toBeInTheDocument();

    // socket.io reconnects and the rejoin succeeds
    mocks.apiGetCharacter.mockResolvedValue({
      character: { ...character, name: 'Tomin Reloaded', updatedAt: '2026-09-26T00:30:00.000Z' },
    });
    lifecycle('authenticated');

    expect(screen.queryByText(OFFLINE)).not.toBeInTheDocument();
    // Anything missed while offline is reloaded
    expect(await screen.findByText('Editing: Tomin Reloaded')).toBeInTheDocument();
    expect(mocks.apiGetCharacter).toHaveBeenCalledWith('char-1');
    // and later events are applied
    remoteRename('Tomin Live', '2026-09-26T01:00:00.000Z');
    expect(screen.getByText('Editing: Tomin Live')).toBeInTheDocument();
    expect(mocks.socket.connect).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('retries with backoff when the connection attempt left no socket', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.socket.connect.mockRejectedValue(new Error('Connection timeout - server did not respond'));

    try {
      renderPage();
      expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
      expect(mocks.socket.connect).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(mocks.socket.connect).toHaveBeenCalledTimes(2);

      mocks.socket.connect.mockResolvedValue(undefined);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(mocks.socket.connect).toHaveBeenCalledTimes(3);
      expect(screen.queryByText(OFFLINE)).not.toBeInTheDocument();

      // Connected: no more attempts
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mocks.socket.connect).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('shows the indicator while disconnected and reloads the character on every rejoin', async () => {
    mocks.socket.getCampaignId.mockReturnValue('camp-1');
    renderPage();
    await waitFor(() => expect(mocks.socket.connect).toHaveBeenCalled());
    await screen.findByText('Editing: Tomin');

    lifecycle('authenticated');
    await waitFor(() => expect(mocks.apiGetCharacter).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(OFFLINE)).not.toBeInTheDocument();

    lifecycle('disconnected');
    expect(screen.getByText(OFFLINE)).toBeInTheDocument();

    lifecycle('authenticated');
    expect(screen.queryByText(OFFLINE)).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.apiGetCharacter).toHaveBeenCalledTimes(2));
  });

  it('schedules a new connection when socket.io gives up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.socket.getCampaignId.mockReturnValue('camp-1');
    try {
      renderPage();
      await waitFor(() => expect(mocks.socket.connect).toHaveBeenCalledTimes(1));

      lifecycle('failed');
      expect(screen.getByText(OFFLINE)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(mocks.socket.connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying with backoff when the client gave up on a timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.socket.getCampaignId.mockReturnValue('camp-1');
    try {
      renderPage();
      await waitFor(() => expect(mocks.socket.connect).toHaveBeenCalledTimes(1));

      lifecycle('failed', { error: 'Connection timeout - server did not respond' });
      expect(screen.getByText(OFFLINE)).toBeInTheDocument();
      expect(screen.queryByText(SESSION_EXPIRED)).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(mocks.socket.connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops reconnecting and asks to sign in again when the session expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.socket.getCampaignId.mockReturnValue('camp-1');
    try {
      renderPage();
      await waitFor(() => expect(mocks.socket.connect).toHaveBeenCalledTimes(1));

      // The server kept rejecting the connection; the client gave up
      lifecycle('failed', { error: 'Unauthorized' });

      expect(screen.getByRole('status')).toHaveTextContent(SESSION_EXPIRED);
      expect(screen.queryByText(OFFLINE)).not.toBeInTheDocument();
      expect(screen.getByText('sheet')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(mocks.socket.connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pending retry is cancelled when the session turns out to be expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.socket.getCampaignId.mockReturnValue('camp-1');
    try {
      renderPage();
      await waitFor(() => expect(mocks.socket.connect).toHaveBeenCalledTimes(1));

      lifecycle('failed', { error: 'Connection timeout - server did not respond' });
      lifecycle('failed', { error: 'Unauthorized' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });

      expect(mocks.socket.connect).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent(SESSION_EXPIRED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('subscribes again when the client replaces its underlying socket', async () => {
    renderPage();
    await waitFor(() => expect(characterUpdatedHandler()).toBeDefined());
    const before = characterUpdatedHandler();
    const subscriptions = mocks.socket.on.mock.calls.length;

    lifecycle('replaced');

    await waitFor(() => expect(mocks.socket.on.mock.calls.length).toBe(subscriptions + 1));
    expect(mocks.socket.off).toHaveBeenCalledWith('character.updated', before);
    expect(characterUpdatedHandler()).not.toBe(before);
    remoteRename('Tomin After Replace', '2026-09-26T02:00:00.000Z');
    expect(screen.getByText('Editing: Tomin After Replace')).toBeInTheDocument();
  });

  it('unmounting mid-connect: the late rejection neither warns nor retries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error');
    let rejectConnect: (reason: Error) => void = () => undefined;
    mocks.socket.connect.mockImplementation(
      () => new Promise<void>((_, reject) => {
        rejectConnect = reject;
      }),
    );

    try {
      const { unmount } = renderPage();
      await waitFor(() => expect(mocks.socket.connect).toHaveBeenCalledTimes(1));

      unmount();
      expect(mocks.socket.disconnect).toHaveBeenCalledTimes(1);
      expect(mocks.lifecycle.size).toBe(0);

      await act(async () => {
        rejectConnect(new Error('Connection abandoned'));
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(mocks.socket.connect).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      vi.useRealTimers();
    }
  });
});
