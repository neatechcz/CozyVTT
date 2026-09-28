import { describe, it, expect } from 'vitest';
import type { NpcStatBlock } from '@/types';
import {
  PF2E_SAVES,
  PF2E_SKILLS,
  formatPf2eSaves,
  isPf2eImplausible,
  readAttributeModifiers,
  setAttributeModifier,
  setPf2eBonus,
} from '../pf2eStatBlock';

/** A PF2e creature as its stat block prints: modifiers, level, three saves. */
const pf2eCreature: NpcStatBlock = {
  ac: 18,
  speed: '25 feet',
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  attributeModifiers: { str: 4, dex: 2, con: 3, int: -1, wis: 1, cha: 0 },
  level: 5,
  savingThrows: { fortitude: 11, reflex: 7, will: 9 },
  skills: { Athletics: 12 },
};

describe('the PF2e structure', () => {
  it('has three saves, not six ability saves', () => {
    expect(PF2E_SAVES).toHaveLength(3);
    expect(PF2E_SAVES.map((s) => s.key)).toEqual(['fortitude', 'reflex', 'will']);
  });

  it('has the sixteen core skills', () => {
    expect(PF2E_SKILLS).toHaveLength(16);
    expect(PF2E_SKILLS).toContain('Thievery');
    expect(PF2E_SKILLS).toContain('Occultism');
    // These are 5e skills with no PF2e equivalent.
    expect(PF2E_SKILLS).not.toContain('Perception');
    expect(PF2E_SKILLS).not.toContain('Insight');
  });
});

describe('readAttributeModifiers', () => {
  // PF2e prints "Str +4" with no score behind it, so inventing one would be
  // wrong. Explicit modifiers win.
  it('uses the printed modifiers', () => {
    const mods = readAttributeModifiers(pf2eCreature);
    expect(mods.str).toBe(4);
    expect(mods.int).toBe(-1);
  });

  it('falls back to deriving from scores for a creature entered 5e-style', () => {
    const legacy: NpcStatBlock = {
      ...pf2eCreature,
      attributeModifiers: undefined,
      abilities: { ...pf2eCreature.abilities, str: 18, int: 8 },
    };
    const mods = readAttributeModifiers(legacy);

    expect(mods.str).toBe(4);
    expect(mods.int).toBe(-1);
  });
});

describe('setAttributeModifier', () => {
  it('stores the modifier explicitly rather than as a score', () => {
    const updated = setAttributeModifier(pf2eCreature, 'str', 6);

    expect(updated.attributeModifiers?.str).toBe(6);
    // The 5e score field is left alone, so switching systems back is lossless.
    expect(updated.abilities.str).toBe(10);
  });

  it('materialises the full set when only some were stored', () => {
    const bare: NpcStatBlock = { ...pf2eCreature, attributeModifiers: undefined };
    const updated = setAttributeModifier(bare, 'dex', 5);

    expect(updated.attributeModifiers?.dex).toBe(5);
    expect(updated.attributeModifiers?.wis).toBe(0);
  });
});

describe('setPf2eBonus', () => {
  it('stores a value verbatim — nothing is derived in PF2e', () => {
    const updated = setPf2eBonus(pf2eCreature, 'savingThrows', 'fortitude', 14);
    expect(updated.savingThrows?.fortitude).toBe(14);
  });

  it('removes an entry when cleared', () => {
    const updated = setPf2eBonus(pf2eCreature, 'skills', 'Athletics', null);
    expect(updated.skills).toBeUndefined();
  });

  it('leaves other entries alone', () => {
    const updated = setPf2eBonus(pf2eCreature, 'savingThrows', 'will', 10);
    expect(updated.savingThrows?.fortitude).toBe(11);
  });
});

describe('isPf2eImplausible', () => {
  // A loose typo-catcher, not Paizo's benchmark table.
  it('accepts values in range for the level', () => {
    expect(isPf2eImplausible(12, 5)).toBe(false);
    expect(isPf2eImplausible(17, 5)).toBe(false); // level 5 extreme Perception
  });

  it('flags a value far too high for the level', () => {
    expect(isPf2eImplausible(40, 2)).toBe(true);
  });

  it('accommodates high-level creatures that legitimately exceed +30', () => {
    // A level 15 extreme skill is +33 in the published benchmarks.
    expect(isPf2eImplausible(33, 15)).toBe(false);
  });

  it('says nothing when the level is unknown', () => {
    expect(isPf2eImplausible(40, undefined)).toBe(false);
  });
});

describe('formatPf2eSaves', () => {
  it('prints the way a stat block does', () => {
    expect(formatPf2eSaves({ fortitude: 11, reflex: 7, will: 9 })).toBe(
      'Fort +11, Ref +7, Will +9'
    );
  });

  it('handles a negative modifier', () => {
    expect(formatPf2eSaves({ will: -1 })).toBe('Will -1');
  });

  it('omits saves that are not recorded', () => {
    expect(formatPf2eSaves({ fortitude: 5 })).toBe('Fort +5');
  });
});
