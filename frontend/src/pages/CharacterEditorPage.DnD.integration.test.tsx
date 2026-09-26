import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameSystem, type Character } from '@/types';
import CharacterEditorPage from './CharacterEditorPage';

const mocks = vi.hoisted(() => ({
  getCharacter: vi.fn(),
  updateCharacter: vi.fn(),
  showToast: vi.fn(),
  deleteAsset: vi.fn(),
  patchCharacterData: vi.fn(),
  apiGetCharacter: vi.fn(),
}));

vi.mock('@/services/character.service', () => ({
  default: {
    getCharacter: mocks.getCharacter,
    updateCharacter: mocks.updateCharacter,
    exportCharacterJSON: vi.fn(),
  },
}));

vi.mock('@/services/campaign.service', () => ({ default: { getCampaign: vi.fn() } }));
// The D&D 5e sheet saves through live sync: a field-level PATCH of the
// edited fields (api.patchCharacterData), not a whole-document PUT.
vi.mock('@/services/api', () => ({
  api: {
    deleteAsset: mocks.deleteAsset,
    patchCharacterData: mocks.patchCharacterData,
    getCharacter: mocks.apiGetCharacter,
  },
}));
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'user-1', platformRole: 'USER' };
  return { useAuth: () => ({ user }) };
});
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));

const character: Character = {
  id: 'character-1',
  userId: 'user-1',
  campaignId: null,
  gameSystem: GameSystem.DND_5E,
  name: 'Robin',
  data: {
    characterName: 'Robin',
    class: 'Fighter',
    level: 1,
    race: 'Elf',
    proficiencyBonus: 2,
    stats: {
      strength: { score: 10, modifier: 0 },
      dexterity: { score: 10, modifier: 0 },
      constitution: { score: 10, modifier: 0 },
      intelligence: { score: 10, modifier: 0 },
      wisdom: { score: 10, modifier: 0 },
      charisma: { score: 10, modifier: 0 },
    },
    savingThrows: {},
    skills: {},
    hp: { maximum: 10, current: 10, temporary: 0 },
    deathSaves: { successes: 0, failures: 0 },
    currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    inventory: [],
    attacks: [],
    hitDice: [],
    conditions: [],
    proficienciesAndLanguages: [],
    featuresAndTraits: [],
    appearance: {},
    personality: {},
    alliesAndOrganizations: { name: '', description: '' },
  } as unknown as Character['data'],
  tokenImageUrl: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
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

/** Server side of a successful PATCH: the changes applied to the stored sheet */
function patchedCharacter(changes: Array<{ path: string; value: unknown }>): Character {
  const data = JSON.parse(JSON.stringify(character.data));
  for (const { path, value } of changes) {
    const keys = path.split('.');
    let target = data;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys[keys.length - 1]] = value;
  }
  return { ...character, data, updatedAt: '2026-09-02T00:00:00.000Z' };
}

describe('CharacterEditorPage with the D&D 5e sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCharacter.mockResolvedValue(character);
    mocks.deleteAsset.mockResolvedValue({ message: 'Asset deleted' });
  });

  it('keeps the first sheet edit made after a failed save and saves that edit', async () => {
    mocks.patchCharacterData
      .mockRejectedValueOnce({ response: { status: 500, data: { message: 'Server error' } } })
      .mockImplementationOnce(async (_id: string, changes: Array<{ path: string; value: unknown }>) => ({
        character: patchedCharacter(changes),
        applied: changes.map((change) => change.path),
        conflicts: [],
        status: 200,
      }));

    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderEditor();

    try {
      const strengthInput = await waitFor(() => {
        const input = screen.getByText('str').parentElement?.querySelector('input[type="number"]');
        expect(input).not.toBeNull();
        return input as HTMLInputElement;
      });
      expect(strengthInput).toHaveValue(10);

      // Live sync sends nothing without an edit: make one, and let it fail
      fireEvent.input(strengthInput, { target: { value: '11' } });
      await user.click(screen.getByRole('button', { name: /^Save$/ }));
      await screen.findByRole('alert');
      expect(screen.getByRole('button', { name: 'Retry Save' })).toBeEnabled();
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
      expect(strengthInput).toHaveValue(11);

      fireEvent.input(strengthInput, { target: { value: '12' } });

      expect(strengthInput).toHaveValue(12);
      expect(screen.queryByRole('button', { name: 'Retry Save' })).not.toBeInTheDocument();
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(mocks.patchCharacterData).toHaveBeenCalledTimes(2));
      expect(mocks.patchCharacterData.mock.calls[1][1]).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'stats.strength.score', value: 12 })]),
      );
      expect(mocks.updateCharacter).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: 'Editing: Robin' })).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it('Retry Save re-sends the live form, not a stale copy of the failed save', async () => {
    mocks.patchCharacterData
      .mockRejectedValueOnce({ response: { status: 503, data: { message: 'Character is busy, retry shortly' } } })
      .mockImplementationOnce(async (_id: string, changes: Array<{ path: string; value: unknown }>) => ({
        character: patchedCharacter(changes),
        applied: changes.map((change) => change.path),
        conflicts: [],
        status: 200,
      }));

    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderEditor();

    try {
      const strengthInput = await waitFor(() => {
        const input = screen.getByText('str').parentElement?.querySelector('input[type="number"]');
        expect(input).not.toBeNull();
        return input as HTMLInputElement;
      });
      fireEvent.input(strengthInput, { target: { value: '14' } });
      await user.click(screen.getByRole('button', { name: /^Save$/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Character is busy, retry shortly');

      await user.click(screen.getByRole('button', { name: 'Retry Save' }));

      await waitFor(() => expect(mocks.patchCharacterData).toHaveBeenCalledTimes(2));
      expect(mocks.patchCharacterData.mock.calls[1][1]).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'stats.strength.score', value: 14 })]),
      );
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry Save' })).not.toBeInTheDocument());
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
      expect(mocks.updateCharacter).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  });
});
