import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@/types';
import NpcQuickEditor from './NpcQuickEditor';
import NpcRollPicker from './NpcRollPicker';
import TokenTemplateLibrary from './TokenTemplateLibrary';

const mocks = vi.hoisted(() => ({ updateToken: vi.fn(), emitMapChange: vi.fn(), listTokenTemplates: vi.fn(), updateTokenTemplate: vi.fn(), listCampaigns: vi.fn() }));
vi.mock('@/services/api', () => ({ default: mocks }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ socket: { emitMapChange: mocks.emitMapChange } }) }));
vi.mock('@/contexts/CampaignContext', () => ({ useCampaign: () => ({ campaign: { id: 'campaign', gameSystem: 'DND_5E', memberships: [] } }) }));
vi.mock('@/hooks/queries', () => ({ useServerConfigQuery: () => ({ data: undefined }) }));
vi.mock('@/components/assets/AssetGrid', () => ({ default: () => null }));

const token = {
  id: 'npc', name: 'Traveller', type: 'npc', visible: true,
  imageUrl: '', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  statBlock: { speed: '30 ft.' },
} as Token;

beforeEach(() => { vi.clearAllMocks(); mocks.updateToken.mockResolvedValue({ token }); });

describe('movement-only NPC blocks', () => {
  it('views and edits saved movement-only token templates without supplying an AC', async () => {
    mocks.listTokenTemplates.mockResolvedValue({ templates: [token], total: 1 });
    mocks.listCampaigns.mockResolvedValue({ campaigns: [] });
    mocks.updateTokenTemplate.mockResolvedValue(token);
    render(<TokenTemplateLibrary isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('Traveller'));
    expect(screen.getByText(/Speed.*30 ft/)).not.toHaveTextContent('AC');
    fireEvent.click(screen.getByTitle('Edit template'));
    fireEvent.click(screen.getByRole('button', { name: 'Stat Block' }));
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '40 ft.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mocks.updateTokenTemplate).toHaveBeenCalledWith('campaign', 'npc', expect.objectContaining({ statBlock: { speed: '40 ft.' } })));
  });

  it('views and edits only the established speed without inventing a full stat block', async () => {
    render(<NpcQuickEditor token={token} campaignId="campaign" mapId="map" onClose={vi.fn()} onTokenUpdate={vi.fn()} />);
    expect(screen.getByText('30 ft.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    const speed = screen.getByLabelText('Speed');
    fireEvent.change(speed, { target: { value: '40 ft.' } });
    fireEvent.blur(speed);
    await waitFor(() => expect(mocks.updateToken).toHaveBeenCalledWith('campaign', 'map', 'npc', { statBlock: { speed: '40 ft.' } }));
    expect(screen.queryByText('STR')).not.toBeInTheDocument();
  });

  it('offers a custom roll without fabricated ability or saving throw options', () => {
    const onRoll = vi.fn();
    render(<NpcRollPicker token={token} onRoll={onRoll} onClose={vi.fn()} anchorX={0} anchorY={0} />);
    expect(screen.queryByText('STR +0')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('e.g. 2d6+3'), { target: { value: '1d20+3' } });
    fireEvent.click(screen.getByRole('button', { name: /^Roll$/ }));
    expect(onRoll).toHaveBeenCalledWith('1d20+3', 'Custom Roll', 'Traveller');
  });
});
