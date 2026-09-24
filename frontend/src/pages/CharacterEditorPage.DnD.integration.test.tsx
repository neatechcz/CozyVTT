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
}));

vi.mock('@/services/character.service', () => ({
  default: {
    getCharacter: mocks.getCharacter,
    updateCharacter: mocks.updateCharacter,
    exportCharacterJSON: vi.fn(),
  },
}));

vi.mock('@/services/campaign.service', () => ({ default: { getCampaign: vi.fn() } }));
vi.mock('@/services/api', () => ({ api: { deleteAsset: mocks.deleteAsset } }));
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

describe('CharacterEditorPage with the D&D 5e sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCharacter.mockResolvedValue(character);
    mocks.deleteAsset.mockResolvedValue({ message: 'Asset deleted' });
  });

  it('keeps the first sheet edit made after a failed save and saves that edit', async () => {
    mocks.updateCharacter
      .mockRejectedValueOnce({ response: { status: 500, data: { message: 'Server error' } } })
      .mockImplementationOnce(async (_id: string, update: Partial<Character>) => ({
        ...character,
        ...update,
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

      await user.click(screen.getByRole('button', { name: /^Save$/ }));
      await screen.findByRole('alert');
      expect(screen.getByRole('button', { name: 'Retry Save' })).toBeEnabled();
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

      fireEvent.input(strengthInput, { target: { value: '11' } });

      expect(strengthInput).toHaveValue(11);
      expect(screen.queryByRole('button', { name: 'Retry Save' })).not.toBeInTheDocument();
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(mocks.updateCharacter).toHaveBeenCalledTimes(2));
      expect(mocks.updateCharacter.mock.calls[1][1].data.stats.strength.score).toBe(11);
      await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: 'Editing: Robin' })).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      consoleLog.mockRestore();
    }
  });
});
