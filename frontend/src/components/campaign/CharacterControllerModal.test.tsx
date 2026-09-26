import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CharacterControllerModal from './CharacterControllerModal';

describe('CharacterControllerModal', () => {
  it('sends the selected campaign player to the save handler', async () => {
    const onSave = vi.fn();
    render(<CharacterControllerModal
      characterName="Mich"
      players={[{ userId: 'vit', displayName: 'Fritol' }]}
      selectedUserId={null}
      saving={false}
      onSave={onSave}
      onClose={() => {}}
    />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /player/i }), 'vit');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith('vit');
  });
});
