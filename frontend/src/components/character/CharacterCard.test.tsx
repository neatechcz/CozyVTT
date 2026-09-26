import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Character } from '@/types';
import CharacterCard from './CharacterCard';

const character = {
  id: 'mich',
  userId: 'mcp-owner',
  name: 'Mich',
  gameSystem: null,
  tokenImageUrl: null,
  updatedAt: new Date().toISOString(),
} as Character;

describe('delegated character card', () => {
  it('offers editing while hiding owner-only actions', () => {
    const onEdit = vi.fn();
    render(<CharacterCard character={character} canManage={false} onEdit={onEdit}
      onCopy={vi.fn()} onDelete={vi.fn()} onAssign={vi.fn()} onExport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Character actions' }));
    expect(screen.getByText('Edit Character')).toBeTruthy();
    expect(screen.queryByText('Copy/Duplicate')).toBeNull();
    expect(screen.queryByText('Assign to Campaign')).toBeNull();
    expect(screen.queryByText('Delete Character')).toBeNull();
    fireEvent.click(screen.getByText('Edit Character'));
    expect(onEdit).toHaveBeenCalledWith(character);
  });
});
