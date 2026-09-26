/**
 * creatureHp.ts
 * Pure helpers for creature (NPC stat block) hit points.
 */

import type { NpcStatBlock, TokenHp } from '@/types';

/** HP given to a placed creature whose stat block has no hit points. */
export const DEFAULT_CREATURE_HP = 10;

/** A finite number above zero (a usable hit point value). */
export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Token HP for a creature placed from the library: the stat block's average
 * hit points (current = max, no temp), or the default when it has none.
 */
export function tokenHpForCreature(statBlock: NpcStatBlock | null | undefined): TokenHp {
  const average = statBlock?.hp?.average;
  const hp = isPositiveNumber(average) ? average : DEFAULT_CREATURE_HP;
  return { current: hp, max: hp, temp: 0 };
}

/** Result of reading the creature form's HP inputs: the hp to store, or a form error. */
export type StatBlockHpFormResult =
  | { ok: true; hp: NpcStatBlock['hp'] }
  | { ok: false; error: string };

/**
 * Validate the creature form's HP inputs and build `statBlock.hp`.
 *
 * The average must be a whole number of at least 1 — decimals are rejected,
 * never truncated. Leaving both the average and the formula empty means
 * "no HP", which is only allowed when the creature had no hit points before
 * (`hadHp` false, e.g. a new creature); clearing existing hit points is an error.
 */
export function parseStatBlockHpForm(
  averageInput: string,
  formulaInput: string,
  hadHp: boolean,
): StatBlockHpFormResult {
  const averageText = averageInput.trim();
  const formula = formulaInput.trim();

  if (!averageText) {
    if (hadHp) return { ok: false, error: 'HP is required: enter a whole number of at least 1' };
    if (formula) return { ok: false, error: 'Enter the HP average for the HP dice' };
    return { ok: true, hp: undefined };
  }

  const average = Number(averageText);
  if (!Number.isFinite(average)) return { ok: false, error: 'HP must be a number' };
  if (!Number.isInteger(average)) return { ok: false, error: 'HP must be a whole number' };
  if (average < 1) return { ok: false, error: 'HP must be at least 1' };

  return { ok: true, hp: formula ? { average, formula } : { average } };
}
