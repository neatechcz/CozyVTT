/**
 * Serialized campaign initiative and current-turn movement state.
 *
 * The Campaign.combatState JSON column is the source of truth. Keep this file
 * free of process-local caches so a reconnect or a server restart restores the
 * same state from the database.
 */

export interface CombatantEntry {
  tokenId: string;
  name: string;
  imageUrl: string;
  initiative: number | null;
  hp: { current: number; max: number; temp: number } | null;
  type: 'player' | 'npc' | 'object';
  disposition: 'friendly' | 'neutral' | 'hostile' | null;
}

/** Current turn's movement accounting. `remainingMovementFeet` is derived. */
export interface MovementLedger {
  tokenId: string;
  turnId: string;
  speedFeet: number | null;
  spentFeet: number;
  dashBonusFeet: number;
  dashUsed: boolean;
  diagonalStepsTaken: number;
  remainingMovementFeet: number | null;
}

export interface CombatState {
  active: boolean;
  round: number;
  /** tokenId of the currently-acting combatant, null if combat is not started */
  currentTokenId: string | null;
  /** Ordered list of combatants (descending by initiative) */
  combatants: CombatantEntry[];
  /** New identity for each combat; invalidates requests from a previous combat. */
  combatId: string | null;
  /** New identity for each actor turn; also scopes the movement ledger. */
  turnId: string | null;
  /** Every combatant in an encounter is required to come from this map. */
  mapId: string | null;
  movement: MovementLedger | null;
}

export function defaultCombatState(): CombatState {
  return {
    active: false,
    round: 0,
    currentTokenId: null,
    combatants: [],
    combatId: null,
    turnId: null,
    mapId: null,
    movement: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseCombatant(value: unknown): CombatantEntry | null {
  if (!isRecord(value) || typeof value.tokenId !== 'string' || typeof value.name !== 'string') return null;
  const type = value.type;
  if (type !== 'player' && type !== 'npc' && type !== 'object') return null;
  const disposition = value.disposition;
  const validDisposition = disposition === 'friendly' || disposition === 'neutral' || disposition === 'hostile';
  const hpValue = value.hp;
  const hp = isRecord(hpValue) && typeof hpValue.current === 'number' && typeof hpValue.max === 'number'
    ? { current: hpValue.current, max: hpValue.max, temp: typeof hpValue.temp === 'number' ? hpValue.temp : 0 }
    : null;

  return {
    tokenId: value.tokenId,
    name: value.name,
    imageUrl: typeof value.imageUrl === 'string' ? value.imageUrl : '',
    initiative: typeof value.initiative === 'number' && Number.isFinite(value.initiative) ? value.initiative : null,
    hp,
    type,
    disposition: validDisposition ? disposition : null,
  };
}

function parseMovement(value: unknown, stateTurnId: string | null): MovementLedger | null {
  if (!isRecord(value) || typeof value.tokenId !== 'string' || typeof value.turnId !== 'string') return null;
  if (stateTurnId === null || value.turnId !== stateTurnId) return null;
  if (!finiteNonNegative(value.spentFeet) || !finiteNonNegative(value.dashBonusFeet)) return null;
  if (!finiteNonNegative(value.diagonalStepsTaken) || typeof value.dashUsed !== 'boolean') return null;
  const speedFeet = value.speedFeet === null || value.speedFeet === undefined
    ? null
    : finiteNonNegative(value.speedFeet) ? value.speedFeet : null;
  const allowance = speedFeet === null ? null : speedFeet + value.dashBonusFeet;

  return {
    tokenId: value.tokenId,
    turnId: value.turnId,
    speedFeet,
    spentFeet: value.spentFeet,
    dashBonusFeet: value.dashBonusFeet,
    dashUsed: value.dashUsed,
    diagonalStepsTaken: value.diagonalStepsTaken,
    remainingMovementFeet: allowance === null ? null : Math.max(0, allowance - value.spentFeet),
  };
}

/** Parse persisted JSON into the public state shape, filling safe defaults. */
export function readCombatState(value: unknown): CombatState {
  if (!isRecord(value)) return defaultCombatState();

  const combatants = Array.isArray(value.combatants)
    ? value.combatants.map(parseCombatant).filter((item): item is CombatantEntry => item !== null)
    : [];
  const turnId = typeof value.turnId === 'string' ? value.turnId : null;
  const state: CombatState = {
    active: value.active === true,
    round: finiteNonNegative(value.round) ? value.round : 0,
    currentTokenId: typeof value.currentTokenId === 'string' ? value.currentTokenId : null,
    combatants,
    combatId: typeof value.combatId === 'string' ? value.combatId : null,
    turnId,
    mapId: typeof value.mapId === 'string' ? value.mapId : null,
    movement: parseMovement(value.movement, turnId),
  };

  if (!state.active) {
    state.combatId = null;
    state.turnId = null;
    state.movement = null;
  } else if (state.movement && state.movement.tokenId !== state.currentTokenId) {
    state.movement = null;
  }

  return state;
}

/** Sort combatants in-place: descending initiative, nulls last, then by name for tie-breaking. */
export function sortCombatants(combatants: CombatantEntry[]): CombatantEntry[] {
  return [...combatants].sort((a, b) => {
    if (a.initiative === null && b.initiative === null) return a.name.localeCompare(b.name);
    if (a.initiative === null) return 1;
    if (b.initiative === null) return -1;
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    return a.name.localeCompare(b.name); // alphabetical tie-break
  });
}
