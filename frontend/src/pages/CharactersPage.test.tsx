import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character } from '@/types';
import CharactersPage from './CharactersPage';

const mocks = vi.hoisted(() => ({
  listCampaigns: vi.fn(),
  createCharacter: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn(), user: { id: 'test-user-id' } }),
}));

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ mascotUrl: '/mascot.svg' }),
}));

vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

vi.mock('@/hooks/queries', () => ({
  queryKeys: { characters: ['characters'], campaigns: ['campaigns'] },
  useCharactersQuery: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
  useCampaignsQuery: () => ({ data: [], isPending: false, error: null, refetch: vi.fn() }),
}));

vi.mock('@/services/character.service', () => ({
  default: {
    copyCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    assignCharacter: vi.fn(),
    unassignCharacter: vi.fn(),
    exportCharacterJSON: vi.fn(),
  },
}));

vi.mock('@/services/api', () => ({
  default: {
    listCampaigns: mocks.listCampaigns,
    createCharacter: mocks.createCharacter,
  },
}));

function RouteMarker() {
  const location = useLocation();
  return <div data-testid="current-path">{location.pathname}</div>;
}

function CharacterEditorMarker() {
  const { id } = useParams();
  return <div data-testid="character-editor">Editing character {id}</div>;
}

function makeCreatedCharacter(): Character {
  return {
    id: 'new-character-id',
    userId: 'test-user-id',
    campaignId: null,
    gameSystem: null,
    name: 'Aria Moonshadow',
    data: {} as Character['data'],
    tokenImageUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function renderCharactersPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/characters']}>
        <RouteMarker />
        <Routes>
          <Route path="/characters" element={<CharactersPage />} />
          <Route path="/characters/:id/edit" element={<CharacterEditorMarker />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openCreateDialogAndSubmitName() {
  fireEvent.click(screen.getByRole('button', { name: 'Create Character' }));
  const dialog = await screen.findByRole('dialog', { name: 'Create New Character' });
  fireEvent.change(within(dialog).getByLabelText(/Character Name/), {
    target: { value: 'Aria Moonshadow' },
  });
  return dialog;
}

describe('CharactersPage character creation', () => {
  beforeEach(() => {
    mocks.listCampaigns.mockResolvedValue({ campaigns: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('opens the new character editor after successful flexible character creation', async () => {
    const newCharacter = makeCreatedCharacter();
    mocks.createCharacter.mockResolvedValue({ character: newCharacter });
    renderCharactersPage();

    const dialog = await openCreateDialogAndSubmitName();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Character' }));

    expect(await screen.findByTestId('character-editor')).toHaveTextContent('new-character-id');
    expect(mocks.showToast).toHaveBeenCalledWith('Character created successfully!', 'success');
  });

  it('keeps the create dialog open and reports the error when creation fails', async () => {
    mocks.createCharacter.mockRejectedValue(new Error('Creation failed'));
    renderCharactersPage();

    const dialog = await openCreateDialogAndSubmitName();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Character' }));

    expect(await screen.findByText('Creation failed')).toBeInTheDocument();
    expect(screen.getByTestId('current-path')).toHaveTextContent('/characters');
    expect(screen.queryByTestId('character-editor')).not.toBeInTheDocument();
    expect(mocks.showToast).not.toHaveBeenCalledWith('Character created successfully!', 'success');
  });
});
