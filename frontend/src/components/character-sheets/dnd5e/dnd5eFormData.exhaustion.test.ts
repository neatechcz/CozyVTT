import { describe, expect, it } from 'vitest';
import { buildDnd5eFormData, prepareDnd5eFormForSave } from './dnd5eFormData';
import { saveFormInputsOf } from './dnd5eFormData';
import { createCharacterFormStore } from '@/utils/characterFormStore';

describe('DnD 5e exhaustion form projection', () => {
  it('shows an upstream-only level in the survival editor and saves both fields', () => {
    const form = buildDnd5eFormData({ exhaustionLevel: 3 });
    expect(form.survival.exhaustionLevel).toBe(3);
    const saved = prepareDnd5eFormForSave(form, 'Classic Red');
    expect(saved.exhaustionLevel).toBe(3);
    expect(saved.survival.exhaustionLevel).toBe(3);
  });

  it('keeps the survival ledger authoritative when both levels disagree', () => {
    const form = buildDnd5eFormData({ exhaustionLevel: 1, survival: { exhaustionLevel: 2, deprivationLockedLevels: 1 } });
    expect(form.exhaustionLevel).toBe(2);
    expect(prepareDnd5eFormForSave(form, 'Classic Red').exhaustionLevel).toBe(2);
  });

  it('saves the top-level alias only when the survival level was edited', () => {
    const store = createCharacterFormStore({ exhaustionLevel: 1, survival: { exhaustionLevel: 1 }, characterName: 'Hero' },
      { normalize: buildDnd5eFormData });
    const original = store.getState().form;
    store.editIn(original, 'characterName', 'Heroine');
    store.derive((form) => prepareDnd5eFormForSave(form, 'Classic Red'), saveFormInputsOf);
    expect(store.snapshotForSave().sent).toMatchObject({ characterName: 'Heroine', exhaustionLevel: 1 });
    store.endSave();

    store.editIn(store.getState().form, 'survival.exhaustionLevel', 2);
    store.derive((form) => prepareDnd5eFormForSave(form, 'Classic Red'), saveFormInputsOf);
    expect(store.snapshotForSave().sent).toMatchObject({ survival: { exhaustionLevel: 2 }, exhaustionLevel: 2 });
  });
});
