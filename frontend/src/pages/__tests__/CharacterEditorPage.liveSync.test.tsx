import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Character } from '@/types';
import CharacterEditorPage from '../CharacterEditorPage';

const mocks = vi.hoisted(() => ({
  getCharacter: vi.fn(),
  updateCharacter: vi.fn(),
  showToast: vi.fn(),
  user: { id: 'owner', displayName: 'Owner' },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user }),
}));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('@/services/character.service', () => ({
  default: {
    getCharacter: mocks.getCharacter,
    updateCharacter: mocks.updateCharacter,
    exportCharacterJSON: vi.fn(),
  },
}));
vi.mock('@/services/campaign.service', () => ({ default: { getCampaign: vi.fn() } }));
vi.mock('@/services/socket', () => {
  const socketClient = { on: vi.fn(), off: vi.fn() };
  return { socketClient, default: socketClient };
});
vi.mock('@/services/api', () => {
  const api = { patchCharacterData: vi.fn(), getCharacter: vi.fn(), updateCharacter: vi.fn(), uploadAsset: vi.fn() };
  return { api, default: api };
});

const ability = (score: number) => ({ score, modifier: Math.floor((score - 10) / 2) });

const character: Character = {
  id: 'char-1',
  userId: 'owner',
  campaignId: null,
  gameSystem: 'DND_5E' as Character['gameSystem'],
  name: 'Tomin',
  data: {
    characterName: 'Tomin',
    class: 'Fighter',
    level: 1,
    race: 'Human',
    proficiencyBonus: 2,
    stats: {
      strength: ability(15),
      dexterity: ability(12),
      constitution: ability(14),
      intelligence: ability(10),
      wisdom: ability(10),
      charisma: ability(8),
    },
    hp: { current: 8, maximum: 12, temporary: 0 },
  } as unknown as Character['data'],
  tokenImageUrl: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/characters/char-1/edit']}>
      <Routes>
        <Route path="/characters/:id/edit" element={<CharacterEditorPage />} />
        <Route path="/characters" element={<div>Characters list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.getCharacter.mockResolvedValue(character);
});

describe('CharacterEditorPage (D&D 5e live sync)', () => {
  it('guards leaving with unsaved edits, and cancelling the editor clears that', async () => {
    renderPage();
    const name = (await screen.findByPlaceholderText('Character Name')) as HTMLInputElement;

    fireEvent.change(name, { target: { value: 'Unsaved' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Back to characters'));
    expect(screen.getByText('You have unsaved changes. Are you sure you want to leave? Your changes will be lost.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Back to characters'));
    expect(await screen.findByText('Characters list')).toBeInTheDocument();
  });

  it('has no stale top Save button for D&D 5e (only the sheet saves)', async () => {
    renderPage();
    await screen.findByPlaceholderText('Character Name');
    expect(screen.getAllByRole('button', { name: /^\s*Save\s*$/ })).toHaveLength(1);
  });
});
