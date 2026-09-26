import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Character } from '@/types';
import { DnD5eCharacterSheet } from './dnd5e/DnD5eCharacterSheet';
import { Pathfinder2eCharacterSheet } from './pathfinder2e/Pathfinder2eCharacterSheet';
import { CallOfCthulhu7eCharacterSheet } from './call-of-cthulhu-7e/CallOfCthulhu7eCharacterSheet';

vi.mock('./dnd5e/DnD5eCharacterEditor', async () => {
  const React = await import('react');
  return {
    DnD5eCharacterEditor: ({ onSave }: any) => {
      const [draft, setDraft] = React.useState('Strength 10');
      const save = async () => {
        try { await onSave({ strength: draft }); } catch { /* Keep the editor draft. */ }
      };
      return (
        <div>
          <label>Strength <input value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
          <button type="button" onClick={() => void save()}>Save sheet</button>
        </div>
      );
    },
  };
});

vi.mock('./dnd5e/DnD5eCharacterView', async () => {
  const React = await import('react');
  return { DnD5eCharacterView: ({ onEdit }: any) => React.createElement('button', { onClick: onEdit }, 'Edit character') };
});

vi.mock('./pathfinder2e/Pathfinder2eCharacterEditor', async () => {
  const React = await import('react');
  return {
    default: function MockPathfinder2eEditor({ onSave }: any) {
      const [draft, setDraft] = React.useState('Strength 10');
      const save = async () => {
        try { await onSave({ strength: draft }); } catch { /* Keep the editor draft. */ }
      };
      return (
        <div>
          <label>Strength <input value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
          <button type="button" onClick={() => void save()}>Save sheet</button>
        </div>
      );
    },
  };
});

vi.mock('./pathfinder2e/Pathfinder2eCharacterView', async () => {
  const React = await import('react');
  return { default: ({ onEdit }: any) => React.createElement('button', { onClick: onEdit }, 'Edit character') };
});

vi.mock('./call-of-cthulhu-7e/CallOfCthulhu7eCharacterEditor', async () => {
  const React = await import('react');
  return {
    CallOfCthulhu7eCharacterEditor: ({ onSave }: any) => {
      const [draft, setDraft] = React.useState('Strength 10');
      const save = async () => {
        try { await onSave({ strength: draft }); } catch { /* Keep the editor draft. */ }
      };
      return (
        <div>
          <label>Strength <input value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
          <button type="button" onClick={() => void save()}>Save sheet</button>
        </div>
      );
    },
  };
});

vi.mock('./call-of-cthulhu-7e/CallOfCthulhu7eCharacterView', async () => {
  const React = await import('react');
  return { CallOfCthulhu7eCharacterView: ({ onEdit }: any) => React.createElement('button', { onClick: onEdit }, 'Edit character') };
});

const character = { id: 'character-1', name: 'Robin', data: {} } as Character;
const wrapperCases = [
  ['D&D 5e', (onSave: any) => <DnD5eCharacterSheet character={character} mode="edit" onSave={onSave} />],
  ['Pathfinder 2e', (onSave: any) => <Pathfinder2eCharacterSheet character={character} mode="edit" onSave={onSave} />],
  ['Call of Cthulhu 7e', (onSave: any) => <CallOfCthulhu7eCharacterSheet character={character} mode="edit" onSave={onSave} />],
] as const;

describe.each(wrapperCases)('%s CharacterSheet wrapper save flow', (_name, renderWrapper) => {
  it('retains the edited draft when the page rejects the save', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('PUT 500'));
    render(renderWrapper(onSave));

    const strength = screen.getByRole('textbox', { name: 'Strength' });
    fireEvent.change(strength, { target: { value: 'Strength 9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sheet' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox', { name: 'Strength' })).toHaveValue('Strength 9');
    expect(screen.queryByRole('button', { name: 'Edit character' })).not.toBeInTheDocument();
  });

  it('returns to the view after a successful save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(renderWrapper(onSave));

    fireEvent.click(screen.getByRole('button', { name: 'Save sheet' }));

    expect(await screen.findByRole('button', { name: 'Edit character' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Strength' })).not.toBeInTheDocument();
  });
});
