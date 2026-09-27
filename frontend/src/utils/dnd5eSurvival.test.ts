import { describe, expect, it } from 'vitest';
import { effectiveMaximumHp, effectiveSpeed, exhaustionEffects, rollWithExhaustion, trackedExhaustionLevel } from './dnd5eSurvival';

describe('2014 D&D 5e exhaustion on a character sheet', () => {
  it('prefers the survival ledger and reads upstream-only exhaustion', () => {
    expect(trackedExhaustionLevel({ survival: { exhaustionLevel: 0 }, exhaustionLevel: 3 })).toBe(0);
    expect(trackedExhaustionLevel({ exhaustionLevel: 3 })).toBe(3);
    expect(trackedExhaustionLevel({})).toBeUndefined();
  });
  it('applies cumulative speed, hit point and fatal effects without changing base values', () => {
    expect(exhaustionEffects(4)).toContain('Hit point maximum halved');
    expect(effectiveSpeed(30, 2)).toBe(15);
    expect(effectiveSpeed(30, 5)).toBe(0);
    expect(effectiveMaximumHp(21, 4)).toBe(10);
    expect(exhaustionEffects(6)).toContain('Death');
  });

  it('combines imposed disadvantage with chosen advantage and leaves damage alone', () => {
    expect(rollWithExhaustion('1d20+3', 'Strength Check', 1, 'normal')).toBe('2d20kl1+3');
    expect(rollWithExhaustion('1d20+3', 'Strength Check', 1, 'advantage')).toBe('1d20+3');
    expect(rollWithExhaustion('1d20+3', 'Sword Attack', 3, 'disadvantage')).toBe('2d20kl1+3');
    expect(rollWithExhaustion('1d20+3', 'Constitution Save', 3, 'normal')).toBe('2d20kl1+3');
    expect(rollWithExhaustion('1d8+3', 'Sword Damage', 4, 'normal')).toBe('1d8+3');
  });
});
