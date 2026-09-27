import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Character } from '../../../types';
import { DnD5eCharacterView } from './DnD5eCharacterView';

describe('DnD5eCharacterView survival', () => {
  it('shows hunger, thirst and the cumulative level-four exhaustion effects', () => {
    const character = {
      id: 'hero', name: 'Hero', data: {
        characterName: 'Hero', level: 2, race: 'Human', class: 'Fighter',
        speed: 30, hp: { current: 18, maximum: 21, temporary: 0 },
        survival: { lastResolvedDay: '8. Mlžníku', foodTodayPounds: 0.5,
          waterTodayGallons: 0.5, waterRequiredGallons: 1,
          daysWithoutFood: 0.5, exhaustionLevel: 4, deprivationLockedLevels: 2 },
        conditions: ['exhausted'],
      },
    } as unknown as Character;
    render(<DnD5eCharacterView character={character} />);
    fireEvent.click(screen.getByRole('button', { name: 'Combat' }));
    expect(screen.getByText(/Food short/i)).toBeInTheDocument();
    expect(screen.getByText(/Water short/i)).toBeInTheDocument();
    expect(screen.getByText('15 ft')).toBeInTheDocument();
    expect(screen.getByText('10/10')).toBeInTheDocument();
    expect(screen.getByText(/Disadvantage on attack rolls and saving throws/i)).toBeInTheDocument();
  });

  it('applies upstream-only exhaustion to displayed speed and hit points', () => {
    const character = { id: 'hero', name: 'Hero', data: {
      characterName: 'Hero', level: 2, race: 'Human', class: 'Fighter',
      speed: 30, hp: { current: 18, maximum: 21, temporary: 0 },
      exhaustionLevel: 4, conditions: ['exhausted'],
    } } as unknown as Character;
    render(<DnD5eCharacterView character={character} />);
    fireEvent.click(screen.getByRole('button', { name: 'Combat' }));
    expect(screen.getByText('15 ft')).toBeInTheDocument();
    expect(screen.getByText('10/10')).toBeInTheDocument();
    expect(screen.queryByText(/level is unknown/i)).not.toBeInTheDocument();
  });
});
