import { describe, expect, it } from '@jest/globals';
import { dnd5eCharacterDataSchema } from './dnd5e.schema';

const requiredCharacterData = {
  characterName: 'Test Character',
  class: 'Wizard',
  level: 1,
  race: 'Human',
  proficiencyBonus: 2,
  stats: {
    strength: { score: 10, modifier: 0 },
    dexterity: { score: 10, modifier: 0 },
    constitution: { score: 10, modifier: 0 },
    intelligence: { score: 10, modifier: 0 },
    wisdom: { score: 10, modifier: 0 },
    charisma: { score: 10, modifier: 0 },
  },
};

describe('D&D 5e spellcasting validation', () => {
  it('accepts a spell slot entry for only the level the character uses', () => {
    const result = dnd5eCharacterDataSchema.safeParse({
      ...requiredCharacterData,
      spellcasting: { slots: { '1': { total: 1, expended: 0 } } },
    });

    expect(result.success).toBe(true);
  });

  it('continues to accept a complete spell slot map', () => {
    const slots = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [String(index + 1), { total: 0, expended: 0 }]),
    );
    const result = dnd5eCharacterDataSchema.safeParse({
      ...requiredCharacterData,
      spellcasting: { slots },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an invalid value in any provided spell slot entry', () => {
    const result = dnd5eCharacterDataSchema.safeParse({
      ...requiredCharacterData,
      spellcasting: { slots: { '1': { total: 1, expended: -1 } } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a slot level outside the D&D 5e range', () => {
    const result = dnd5eCharacterDataSchema.safeParse({
      ...requiredCharacterData,
      spellcasting: { slots: { '10': { total: 1, expended: 0 } } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a spell with an empty required name', () => {
    const result = dnd5eCharacterDataSchema.safeParse({
      ...requiredCharacterData,
      spellcasting: {
        spells: [{ level: 1, name: '', prepared: false, ritual: false, concentration: false }],
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('D&D 5e survival state', () => {
  it('preserves the open intake day without claiming it was resolved', () => {
    const survival = { intakeDay: '8. Mlžníku L. K. 351', daysWithoutFood: 0,
      foodTodayPounds: 1, waterRequiredGallons: 1,
      exhaustionLevel: 0, deprivationLockedLevels: 0 };
    const result = dnd5eCharacterDataSchema.safeParse({ ...requiredCharacterData, survival });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as any).survival).toEqual(survival);
  });

  it('rejects a blank intake day', () => {
    const result = dnd5eCharacterDataSchema.safeParse({ ...requiredCharacterData,
      survival: { intakeDay: '   ', foodTodayPounds: 1 } });
    expect(result.success).toBe(false);
  });

  it('preserves a dated food, water, and exhaustion tracker', () => {
    const survival = { lastResolvedDay: '8. Mlžníku', daysWithoutFood: 0.5,
      foodTodayPounds: 0.5, waterTodayGallons: 0.5, waterRequiredGallons: 1,
      exhaustionLevel: 2, deprivationLockedLevels: 1 };
    const result = dnd5eCharacterDataSchema.safeParse({ ...requiredCharacterData, survival });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as any).survival).toEqual(survival);
  });

  it('rejects negative intake and more locked levels than total exhaustion', () => {
    expect(dnd5eCharacterDataSchema.safeParse({ ...requiredCharacterData,
      survival: { waterTodayGallons: -0.5 } }).success).toBe(false);
    expect(dnd5eCharacterDataSchema.safeParse({ ...requiredCharacterData,
      survival: { exhaustionLevel: 1, deprivationLockedLevels: 2 } }).success).toBe(false);
  });
});
