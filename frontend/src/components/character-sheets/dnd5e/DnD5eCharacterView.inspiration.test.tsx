import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GameSystem, type Character } from '../../../types';
import { DnD5eCharacterView } from './DnD5eCharacterView';

function character(inspiration?: boolean): Character {
  return {
    id: 'hero', userId: 'player', campaignId: 'campaign', gameSystem: GameSystem.DND_5E,
    name: 'Robin', tokenImageUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    data: {
      characterName: 'Robin', class: 'Rogue', level: 2, race: 'Elf', proficiencyBonus: 2,
      inspiration,
      stats: {
        strength: { score: 10, modifier: 0 }, dexterity: { score: 16, modifier: 3 },
        constitution: { score: 10, modifier: 0 }, intelligence: { score: 10, modifier: 0 },
        wisdom: { score: 10, modifier: 0 }, charisma: { score: 10, modifier: 0 },
      },
    },
  } as Character;
}

describe('DnD5eCharacterView Inspiration', () => {
  it('shows the 2014 advantage rule and a clear available/spent state', () => {
    const { rerender } = render(<DnD5eCharacterView character={character(true)} />);
    expect(screen.getByText('Inspirace')).toBeInTheDocument();
    expect(screen.getByText('K dispozici')).toBeInTheDocument();
    expect(screen.getByText(/Před hodem.*výhodu/i)).toBeInTheDocument();

    rerender(<DnD5eCharacterView character={character(false)} />);
    expect(screen.getByText('Vyčerpána')).toBeInTheDocument();

    rerender(<DnD5eCharacterView character={character()} />);
    expect(screen.getByText('Inspirace')).toBeInTheDocument();
    expect(screen.getByText('Vyčerpána')).toBeInTheDocument();
  });
});
