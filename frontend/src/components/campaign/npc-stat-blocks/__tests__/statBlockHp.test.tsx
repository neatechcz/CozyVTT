import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NpcStatBlock } from '@/types';
import Dnd5eStatBlock from '../Dnd5eStatBlock';
import GenericStatBlock from '../GenericStatBlock';

const goblin: NpcStatBlock = {
  ac: 15,
  speed: '30 ft.',
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
};

describe('Dnd5eStatBlock hit points', () => {
  it('renders "Hit Points 7 (2d6)" when hp is present', () => {
    render(<Dnd5eStatBlock statBlock={{ ...goblin, hp: { average: 7, formula: '2d6' } }} tokenName="Goblin" />);
    expect(screen.getByText('Hit Points').parentElement).toHaveTextContent('Hit Points 7 (2d6)');
  });

  it('renders the average alone when there is no formula', () => {
    render(<Dnd5eStatBlock statBlock={{ ...goblin, hp: { average: 7 } }} tokenName="Goblin" />);
    expect(screen.getByText('Hit Points').parentElement?.textContent).toBe('Hit Points 7');
  });

  it('renders no hit points line when hp is absent', () => {
    render(<Dnd5eStatBlock statBlock={goblin} tokenName="Goblin" />);
    expect(screen.queryByText('Hit Points')).toBeNull();
  });
});

describe('GenericStatBlock hit points', () => {
  it('renders HP with the formula when present', () => {
    render(<GenericStatBlock statBlock={{ ...goblin, hp: { average: 7, formula: '2d6' } }} tokenName="Goblin" />);
    expect(screen.getByText('HP').parentElement).toHaveTextContent('HP 7 (2d6)');
  });

  it('renders no HP when hp is absent', () => {
    render(<GenericStatBlock statBlock={goblin} tokenName="Goblin" />);
    expect(screen.queryByText('HP')).toBeNull();
  });
});
