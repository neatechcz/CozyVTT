import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import fullInvestigatorExport from '../../../../../Examples/Call_of_Cthulhu_7th_Edition_character.json';
import { callOfCthulhu7eCharacterDataSchema } from '../../../../../backend/src/validators/game-systems/callOfCthulhu7e.schema';
import { GameSystem, type Character } from '../../../types';
import { CallOfCthulhu7eCharacterEditor } from './CallOfCthulhu7eCharacterEditor';

const mocks = vi.hoisted(() => ({
  uploadAsset: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  api: { uploadAsset: mocks.uploadAsset },
}));

function makeMinimalInvestigator(skills?: unknown): Character {
  const data: any = {
    investigatorName: 'Dr. Sarah Chen',
    occupation: 'Professor of Archaeology',
    era: '1920s',
    characteristics: {
      STR: { regular: 50, half: 25, fifth: 10 },
      CON: { regular: 60, half: 30, fifth: 12 },
      SIZ: { regular: 55, half: 27, fifth: 11 },
      DEX: { regular: 50, half: 25, fifth: 10 },
      APP: { regular: 65, half: 32, fifth: 13 },
      INT: { regular: 80, half: 40, fifth: 16 },
      POW: { regular: 70, half: 35, fifth: 14 },
      EDU: { regular: 85, half: 42, fifth: 17 },
    },
  };
  if (skills !== undefined) data.skills = skills;

  return {
    id: 'sarah-id',
    userId: 'player-id',
    campaignId: 'campaign-id',
    gameSystem: GameSystem.CALL_OF_CTHULHU_7E,
    name: 'Minimal Investigator',
    data,
    tokenImageUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('CallOfCthulhu7eCharacterEditor', () => {
  it.each([
    { label: 'missing', character: makeMinimalInvestigator() },
    { label: 'null', character: makeMinimalInvestigator(null) },
    { label: 'empty', character: makeMinimalInvestigator({}) },
  ])('saves an unchanged minimal investigator with $label skills as schema-valid data', async ({ character }) => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CallOfCthulhu7eCharacterEditor
        character={character}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedData = onSave.mock.calls[0][0];
    const validation = callOfCthulhu7eCharacterDataSchema.safeParse(savedData);

    expect(savedData.skills).toBeUndefined();
    expect(validation.success, validation.success ? undefined : JSON.stringify(validation.error.issues)).toBe(true);
  });

  it('preserves a complete existing skills object when saving', async () => {
    const existingSkills = fullInvestigatorExport.character.data.skills;
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CallOfCthulhu7eCharacterEditor
        character={makeMinimalInvestigator(existingSkills)}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedData = onSave.mock.calls[0][0];
    const validation = callOfCthulhu7eCharacterDataSchema.safeParse(savedData);

    expect(savedData.skills).toEqual(existingSkills);
    expect(validation.success, validation.success ? undefined : JSON.stringify(validation.error.issues)).toBe(true);
  });

  it('saves a normal edit to a minimal investigator with schema-valid data', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CallOfCthulhu7eCharacterEditor
        character={makeMinimalInvestigator()}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Investigator Name'), {
      target: { value: 'Dr. Sarah Chen, Updated' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedData = onSave.mock.calls[0][0];
    const validation = callOfCthulhu7eCharacterDataSchema.safeParse(savedData);

    expect(savedData.investigatorName).toBe('Dr. Sarah Chen, Updated');
    expect(savedData.skills).toBeUndefined();
    expect(validation.success, validation.success ? undefined : JSON.stringify(validation.error.issues)).toBe(true);
  });

  it('saves a new token image for a minimal investigator with schema-valid data', async () => {
    mocks.uploadAsset.mockResolvedValue({ asset: { id: 'new-token-id' } });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <CallOfCthulhu7eCharacterEditor
        character={makeMinimalInvestigator()}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    const image = new File(['portrait'], 'sarah.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('#token-upload')!, {
      target: { files: [image] },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [savedData, showToast, tokenImageUrl] = onSave.mock.calls[0];
    const validation = callOfCthulhu7eCharacterDataSchema.safeParse(savedData);

    expect(mocks.uploadAsset).toHaveBeenCalledTimes(1);
    expect(savedData.skills).toBeUndefined();
    expect(validation.success, validation.success ? undefined : JSON.stringify(validation.error.issues)).toBe(true);
    expect(showToast).toBe(true);
    expect(tokenImageUrl).toBe('/api/assets/tokens/new-token-id');
  });
});
