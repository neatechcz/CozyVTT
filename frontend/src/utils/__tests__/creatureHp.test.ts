import { describe, expect, it } from 'vitest';
import type { NpcStatBlock } from '@/types';
import { DEFAULT_CREATURE_HP, isPositiveNumber, parseStatBlockHpForm, tokenHpForCreature } from '../creatureHp';

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

describe('parseStatBlockHpForm', () => {
  it('builds { average, formula } from the form inputs', () => {
    expect(parseStatBlockHpForm('7', '2d6', true)).toEqual({ ok: true, hp: { average: 7, formula: '2d6' } });
    expect(parseStatBlockHpForm(' 12 ', ' 3d6+2 ', false)).toEqual({ ok: true, hp: { average: 12, formula: '3d6+2' } });
  });

  it('omits an empty formula', () => {
    expect(parseStatBlockHpForm('7', '  ', false)).toEqual({ ok: true, hp: { average: 7 } });
  });

  it('allows explicit "no HP" only when both inputs are empty and the creature had none', () => {
    expect(parseStatBlockHpForm('', '', false)).toEqual({ ok: true, hp: undefined });
    expect(parseStatBlockHpForm('  ', ' ', false)).toEqual({ ok: true, hp: undefined });
  });

  it('rejects a cleared average when the creature had hit points', () => {
    expect(parseStatBlockHpForm('', '', true)).toEqual({ ok: false, error: 'HP is required: enter a whole number of at least 1' });
    expect(parseStatBlockHpForm('', '2d6', true).ok).toBe(false);
  });

  it('rejects hit dice without an average', () => {
    expect(parseStatBlockHpForm('', '2d6', false)).toEqual({ ok: false, error: 'Enter the HP average for the HP dice' });
  });

  it('rejects values that are not a number', () => {
    expect(parseStatBlockHpForm('abc', '', false)).toEqual({ ok: false, error: 'HP must be a number' });
    expect(parseStatBlockHpForm('7x', '', true)).toEqual({ ok: false, error: 'HP must be a number' });
  });

  it('rejects non-integers instead of truncating them', () => {
    expect(parseStatBlockHpForm('7.5', '', true)).toEqual({ ok: false, error: 'HP must be a whole number' });
    expect(parseStatBlockHpForm('7.9', '2d6', false)).toEqual({ ok: false, error: 'HP must be a whole number' });
  });

  it('rejects zero and negative values', () => {
    expect(parseStatBlockHpForm('0', '', false)).toEqual({ ok: false, error: 'HP must be at least 1' });
    expect(parseStatBlockHpForm('-3', '', true)).toEqual({ ok: false, error: 'HP must be at least 1' });
  });

  it('accepts an integer written with a trailing .0', () => {
    expect(parseStatBlockHpForm('7.0', '', false)).toEqual({ ok: true, hp: { average: 7 } });
  });
});

describe('isPositiveNumber', () => {
  it('accepts only finite numbers above zero', () => {
    expect(isPositiveNumber(7)).toBe(true);
    expect(isPositiveNumber(0)).toBe(false);
    expect(isPositiveNumber(-1)).toBe(false);
    expect(isPositiveNumber(Number.NaN)).toBe(false);
    expect(isPositiveNumber('7')).toBe(false);
    expect(isPositiveNumber(undefined)).toBe(false);
  });
});
