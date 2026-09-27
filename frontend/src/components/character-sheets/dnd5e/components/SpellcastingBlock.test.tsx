import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpellcastingBlock } from './SpellcastingBlock';

const requests = vi.hoisted(() => ({
  calls: [] as Array<[string, string]>,
  load: async (_campaignId: string, _name: string): Promise<{ name: string; description: string }> => ({
    name: '', description: '',
  }),
}));
vi.mock('../../../../services/api', () => ({
  default: {
    getSpellDescription: (campaignId: string, name: string) => {
      requests.calls.push([campaignId, name]);
      return requests.load(campaignId, name);
    },
  },
}));

const spellcasting = {
  class: 'Wizard', ability: 'INT', spellSaveDC: 13, spellAttackBonus: 5,
  cantrips: ['Light'], slots: { '1': { total: 2, expended: 0 } } as any,
  spells: [{ level: 1, name: 'Magic Missile', prepared: true, ritual: false, concentration: false }],
};

beforeEach(() => {
  requests.calls.length = 0;
  requests.load = async () => ({ name: '', description: '' });
});

describe('SpellcastingBlock details', () => {
  it('opens a cantrip description as rendered Markdown and collapses it', async () => {
    requests.load = async () => ({ name: 'Light', description: '**Bright** light.' });
    render(<SpellcastingBlock spellcasting={spellcasting} campaignId="campaign-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    const detail = await screen.findByRole('region', { name: 'Detail kouzla Light' });
    expect(within(detail).getByText('Bright').tagName).toBe('STRONG');
    expect(requests.calls).toEqual([['campaign-1', 'Light']]);
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(screen.queryByRole('region', { name: 'Detail kouzla Light' })).not.toBeInTheDocument();
  });

  it('does not show a previous spell description after a live list change', async () => {
    requests.load = async (_campaignId, name) => ({ name, description: `${name} rules.` });
    const { rerender } = render(<SpellcastingBlock spellcasting={spellcasting} campaignId="campaign-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(await screen.findByText('Light rules.')).toBeInTheDocument();

    rerender(<SpellcastingBlock spellcasting={{ ...spellcasting, cantrips: ['Mage Hand'] }} campaignId="campaign-1" />);
    expect(screen.queryByText('Light rules.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mage Hand' }));
    expect(await screen.findByText('Mage Hand rules.')).toBeInTheDocument();
    expect(requests.calls).toEqual([['campaign-1', 'Light'], ['campaign-1', 'Mage Hand']]);
  });

  it('opens a levelled spell description', async () => {
    requests.load = async () => ({ name: 'Magic Missile', description: 'Three darts.' });
    render(<SpellcastingBlock spellcasting={spellcasting} campaignId="campaign-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Magic Missile' }));
    expect(await screen.findByText('Three darts.')).toBeInTheDocument();
    expect(requests.calls).toEqual([['campaign-1', 'Magic Missile']]);
  });

  it('explains an absent description and a character without a campaign', async () => {
    requests.load = async () => { throw Object.assign(new Error('not found'), { response: { status: 404 } }); };
    const { rerender } = render(<SpellcastingBlock spellcasting={spellcasting} campaignId="campaign-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(await screen.findByText('Popis kouzla zatím není nahraný.')).toBeInTheDocument();
    rerender(<SpellcastingBlock spellcasting={spellcasting} campaignId={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(await screen.findByText('Popisy kouzel jsou dostupné jen v kampani.')).toBeInTheDocument();
    expect(requests.calls).toEqual([['campaign-1', 'Light']]);
  });
});
