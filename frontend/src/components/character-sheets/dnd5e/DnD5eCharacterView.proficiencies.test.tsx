import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GameSystem, type Character } from '../../../types';
import { DnD5eCharacterView } from './DnD5eCharacterView';

describe('DnD5eCharacterView proficiencies', () => {
  it('shows Czech training under its matching headings', () => {
    const character = {
      id: 'tomin-id',
      userId: 'player-id',
      campaignId: 'campaign-id',
      gameSystem: GameSystem.DND_5E,
      name: 'Tomin',
      data: {
        characterName: 'Tomin', class: 'Paladin', level: 1, race: 'Dwarf', proficiencyBonus: 2,
        stats: {
          strength: { score: 10, modifier: 0 },
          dexterity: { score: 10, modifier: 0 },
          constitution: { score: 10, modifier: 0 },
          intelligence: { score: 10, modifier: 0 },
          wisdom: { score: 10, modifier: 0 },
          charisma: { score: 10, modifier: 0 },
        },
        proficienciesAndLanguages: [
          'Záchranné hody na Moudrost', 'Všechny zbroje', 'Štíty',
          'Jednoduché zbraně', 'Kovářské nářadí', 'Obecná řeč', 'Historie',
        ],
      },
      tokenImageUrl: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    } as Character;

    render(<DnD5eCharacterView character={character} />);
    fireEvent.click(screen.getByRole('button', { name: 'Features' }));
    const section = screen.getByText('Proficiencies & Training').closest('div.bg-stone-50') as HTMLElement;
    expect(within(section).getByText('Armor').parentElement).toHaveTextContent('Všechny zbroje, Štíty');
    expect(within(section).getByText('Weapons').parentElement).toHaveTextContent('Jednoduché zbraně');
    expect(within(section).getByText('Tools').parentElement).toHaveTextContent('Kovářské nářadí');
    expect(within(section).getByText('Languages').parentElement).toHaveTextContent('Obecná řeč');
    expect(within(section).getByText('Other Training').parentElement).toHaveTextContent('Záchranné hody na Moudrost, Historie');
  });
});
