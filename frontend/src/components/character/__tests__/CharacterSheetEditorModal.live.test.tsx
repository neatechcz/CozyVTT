import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createdSockets as created, handshake, type FakeSocket } from '@/test/fakeSocketIo';
import { WebSocketProvider } from '@/contexts/WebSocketContext';
import type { CharacterFormStore } from '@/utils/characterFormStore';
import type { Character } from '@/types';
import CharacterSheetEditorModal from '../CharacterSheetEditorModal';

// The campaign page's modal editor subscribes once to the stable socket
// client. It must keep receiving character.updated after the client builds a
// new underlying socket, and reload the character after every rejoin of the
// campaign room (changes whose broadcast was missed while disconnected).

const mocks = vi.hoisted(() => ({
  getCharacter: vi.fn(),
  patchCharacterData: vi.fn(),
  updateCharacter: vi.fn(),
}));

vi.mock('socket.io-client', async () => (await import('@/test/fakeSocketIo')).fakeSocketIoModule);
vi.mock('@/services/api', () => {
  const api = {
    getCharacter: mocks.getCharacter,
    patchCharacterData: mocks.patchCharacterData,
    updateCharacter: mocks.updateCharacter,
    pingSession: vi.fn(),
  };
  return { api, default: api };
});
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
// The editor itself is covered elsewhere: this one shows the live form value
vi.mock('@/components/character-sheets/dnd5e/DnD5eCharacterEditor', () => ({
  default: function LiveFormProbe({ formStore }: { formStore: CharacterFormStore }) {
    const state = useSyncExternalStore(formStore.subscribe, formStore.getState);
    return <div data-testid="xp">{String((state.form as { experiencePoints?: number }).experiencePoints)}</div>;
  },
}));

const T0 = '2026-09-26T00:00:00.000Z';

function makeCharacter(experiencePoints: number, updatedAt: string): Character {
  return {
    id: 'char-1',
    userId: 'owner',
    campaignId: 'camp-1',
    gameSystem: 'DND_5E' as Character['gameSystem'],
    name: 'Tomin',
    data: { characterName: 'Tomin', experiencePoints } as unknown as Character['data'],
    tokenImageUrl: null,
    createdAt: T0,
    updatedAt,
  };
}

function remoteUpdate(socket: FakeSocket, experiencePoints: number, updatedAt: string) {
  act(() => {
    socket.fire('character.updated', {
      characterId: 'char-1',
      character: makeCharacter(experiencePoints, updatedAt),
      userId: 'gm',
      changedPaths: ['experiencePoints'],
      updatedBy: { userId: 'gm', displayName: 'Pán jeskyně' },
    });
  });
}

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

async function renderConnected() {
  render(
    <MemoryRouter initialEntries={['/campaigns/camp-1']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route
          path="/campaigns/:id"
          element={
            <WebSocketProvider>
              <CharacterSheetEditorModal character={makeCharacter(100, T0)} onClose={vi.fn()} />
            </WebSocketProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  expect(created).toHaveLength(1);
  act(() => handshake(created[0]));
  await flush();
  expect(screen.getByTestId('xp').textContent).toBe('100');
}

beforeEach(() => {
  created.length = 0;
  vi.useFakeTimers();
  mocks.getCharacter.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CharacterSheetEditorModal live connection', () => {
  it('receives character.updated on the new socket after the client replaced it, and reloads after rejoining', async () => {
    await renderConnected();
    remoteUpdate(created[0], 150, '2026-09-26T00:01:00.000Z');
    expect(screen.getByTestId('xp').textContent).toBe('150');
    expect(mocks.getCharacter).not.toHaveBeenCalled();

    // Missed while disconnected: the rejoin reload brings it in
    mocks.getCharacter.mockResolvedValue({ character: makeCharacter(175, '2026-09-26T00:02:00.000Z') });

    // Server-forced disconnect: the client builds a new socket after a backoff
    act(() => created[0].fire('disconnect', 'io server disconnect'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(created).toHaveLength(2);
    act(() => handshake(created[1]));
    await flush();

    expect(mocks.getCharacter).toHaveBeenCalledTimes(1);
    expect(mocks.getCharacter).toHaveBeenCalledWith('char-1');
    expect(screen.getByTestId('xp').textContent).toBe('175');

    remoteUpdate(created[1], 200, '2026-09-26T00:03:00.000Z');
    expect(screen.getByTestId('xp').textContent).toBe('200');
  });

  it('reloads the character when socket.io re-authenticates the same socket after a drop', async () => {
    await renderConnected();
    mocks.getCharacter.mockResolvedValue({ character: makeCharacter(120, '2026-09-26T00:01:00.000Z') });

    act(() => {
      created[0].fire('disconnect', 'transport close');
      handshake(created[0]);
    });
    await flush();

    expect(created).toHaveLength(1);
    expect(mocks.getCharacter).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('xp').textContent).toBe('120');
  });
});
