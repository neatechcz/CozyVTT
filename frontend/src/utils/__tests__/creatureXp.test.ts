import { describe, expect, it } from 'vitest';
import { CR_XP, xpForChallengeRating } from '../creatureXp';

describe('xpForChallengeRating', () => {
  it('maps SRD challenge ratings to xp', () => {
    expect(xpForChallengeRating('0')).toBe(10);
    expect(xpForChallengeRating('1/8')).toBe(25);
    expect(xpForChallengeRating('1/4')).toBe(50);
    expect(xpForChallengeRating('1')).toBe(200);
    expect(xpForChallengeRating('30')).toBe(155000);
  });

  it('trims the input', () => {
    expect(xpForChallengeRating(' 2 ')).toBe(450);
  });

  it('returns undefined for unknown ratings and inherited object keys', () => {
    expect(xpForChallengeRating('')).toBeUndefined();
    expect(xpForChallengeRating('31')).toBeUndefined();
    expect(xpForChallengeRating('0.25')).toBeUndefined();
    expect(xpForChallengeRating('constructor')).toBeUndefined();
    expect(xpForChallengeRating('toString')).toBeUndefined();
  });

  it('matches the backend seed table (34 SRD ratings)', () => {
    expect(Object.keys(CR_XP)).toHaveLength(34);
  });
});
