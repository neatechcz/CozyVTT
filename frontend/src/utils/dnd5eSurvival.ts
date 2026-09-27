import { withAdvantage, withDisadvantage } from './characterRolls';

export type RollMode = 'normal' | 'advantage' | 'disadvantage';

/** The survival ledger is authoritative; older or upstream sheets may only have the top-level field. */
export function trackedExhaustionLevel(data: { survival?: { exhaustionLevel?: number }; exhaustionLevel?: number }): number | undefined {
  return data.survival?.exhaustionLevel ?? data.exhaustionLevel;
}

const EFFECTS = [
  'Disadvantage on ability checks',
  'Speed halved',
  'Disadvantage on attack rolls and saving throws',
  'Hit point maximum halved',
  'Speed reduced to 0',
  'Death',
] as const;

/** Cumulative effects of D&D 5e 2014 exhaustion. */
export function exhaustionEffects(level: number): string[] {
  return EFFECTS.slice(0, Math.max(0, Math.min(6, level)));
}

export function effectiveSpeed(baseSpeed: number, level: number): number {
  if (level >= 5) return 0;
  return level >= 2 ? Math.floor(baseSpeed / 2) : baseSpeed;
}

export function effectiveMaximumHp(baseMaximum: number, level: number): number {
  return level >= 4 ? Math.floor(baseMaximum / 2) : baseMaximum;
}

/** Combines the player's roll mode with exhaustion. One advantage cancels one disadvantage. */
export function rollWithExhaustion(expression: string, purpose: string, level: number, mode: RollMode): string {
  if (!expression.startsWith('1d20')) return expression;
  const abilityCheck = /\b(Check|Initiative)\b/i.test(purpose);
  const attackOrSave = /\b(Attack|Saving Throw|Save)\b/i.test(purpose);
  const imposedDisadvantage = (level >= 1 && abilityCheck) || (level >= 3 && attackOrSave);
  const effectiveMode = imposedDisadvantage && mode === 'advantage'
    ? 'normal'
    : imposedDisadvantage ? 'disadvantage' : mode;
  return effectiveMode === 'advantage' ? withAdvantage(expression)
    : effectiveMode === 'disadvantage' ? withDisadvantage(expression) : expression;
}
