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
