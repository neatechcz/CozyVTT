/** D&D 5e 2014 exhaustion uses the survival ledger when both formats exist. */
export function dnd5eExhaustionLevel(data: Record<string, unknown>): number {
  const survival = data.survival as Record<string, unknown> | undefined;
  const level = survival?.exhaustionLevel ?? data.exhaustionLevel;
  return typeof level === 'number' && Number.isFinite(level) ? level : 0;
}

export function effectiveDnd5eHpMaximum(data: Record<string, unknown>): number | null {
  const hp = data.hp as Record<string, unknown> | undefined;
  if (!hp || typeof hp.maximum !== 'number' || !Number.isFinite(hp.maximum)) return null;
  return dnd5eExhaustionLevel(data) >= 4 ? Math.floor(hp.maximum / 2) : hp.maximum;
}

/** Preserve the base maximum but never persist current HP above the effective maximum. */
export function clampDnd5eCurrentHp(data: Record<string, unknown>): { data: Record<string, unknown>; changed: boolean } {
  const maximum = effectiveDnd5eHpMaximum(data);
  const hp = data.hp as Record<string, unknown> | undefined;
  if (maximum === null || !hp || typeof hp.current !== 'number' || hp.current <= maximum) {
    return { data, changed: false };
  }
  return { data: { ...data, hp: { ...hp, current: maximum } }, changed: true };
}
