/**
 * creatureHp.ts
 * Pure helpers for creature (NPC stat block) hit points.
 */

import type { NpcStatBlock, TokenHp } from '@/types';

/** HP given to a placed creature whose stat block has no hit points. */
export const DEFAULT_CREATURE_HP = 10;

function isPositiveNumber(value: unknown): value is number {
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

/**
 * Build `statBlock.hp` from the creature form's text inputs.
 * Returns undefined when the average is blank or not a positive integer.
 */
export function statBlockHpFromForm(averageInput: string, formulaInput: string): NpcStatBlock['hp'] {
  const average = parseInt(averageInput.trim(), 10);
  if (!isPositiveNumber(average)) return undefined;
  const formula = formulaInput.trim();
  return formula ? { average, formula } : { average };
}
