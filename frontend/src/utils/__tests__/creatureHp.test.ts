import { describe, expect, it } from 'vitest';
import type { NpcStatBlock } from '@/types';
import { DEFAULT_CREATURE_HP, statBlockHpFromForm, tokenHpForCreature } from '../creatureHp';

const base: NpcStatBlock = {
  ac: 15,
  speed: '30 ft.',
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
};

describe('tokenHpForCreature', () => {
  it('uses the stat block average for current and max', () => {
    expect(tokenHpForCreature({ ...base, hp: { average: 7, formula: '2d6' } })).toEqual({ current: 7, max: 7, temp: 0 });
  });

  it('falls back to the default when the creature has no hp', () => {
    expect(DEFAULT_CREATURE_HP).toBe(10);
    expect(tokenHpForCreature(base)).toEqual({ current: 10, max: 10, temp: 0 });
    expect(tokenHpForCreature(null)).toEqual({ current: 10, max: 10, temp: 0 });
    expect(tokenHpForCreature(undefined)).toEqual({ current: 10, max: 10, temp: 0 });
  });

  it('falls back to the default when hp.average is not a positive number', () => {
    expect(tokenHpForCreature({ ...base, hp: { average: 0 } })).toEqual({ current: 10, max: 10, temp: 0 });
    expect(tokenHpForCreature({ ...base, hp: { average: 'x' as unknown as number } })).toEqual({ current: 10, max: 10, temp: 0 });
  });
});

describe('statBlockHpFromForm', () => {
  it('builds { average, formula } from the form inputs', () => {
    expect(statBlockHpFromForm('7', '2d6')).toEqual({ average: 7, formula: '2d6' });
  });

  it('omits an empty formula', () => {
    expect(statBlockHpFromForm('7', '  ')).toEqual({ average: 7 });
  });

  it('returns undefined when the average is blank or invalid', () => {
    expect(statBlockHpFromForm('', '2d6')).toBeUndefined();
    expect(statBlockHpFromForm('abc', '')).toBeUndefined();
    expect(statBlockHpFromForm('0', '')).toBeUndefined();
  });
});
