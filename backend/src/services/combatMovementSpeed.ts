import type {
  MovementErrorCode,
  MovementFootprintSize,
  MovementResult,
} from './combatMovement';

export type Dnd5eSizeCategory = 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan';

export type MovementSpeedActor =
  | { kind: 'pc'; characterData: unknown; conditions?: unknown }
  | {
      kind: 'npc';
      statBlock: unknown;
      conditions?: unknown;
      exhaustionLevel?: unknown;
      metadata?: unknown;
    };

export interface MovementSizeInput {
  sizeCategory?: unknown;
  statBlock?: unknown;
  characterData?: unknown;
  metadata?: unknown;
  footprint?: MovementFootprintSize;
}

export interface MovementSizeResolution {
  minimum: Dnd5eSizeCategory;
  maximum: Dnd5eSizeCategory;
  source: 'explicit' | 'statBlock' | 'characterData' | 'metadata' | 'footprint';
}

const SIZE_CATEGORIES: readonly Dnd5eSizeCategory[] = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'];

const failure = (code: MovementErrorCode, message: string): MovementResult<never> => ({
  ok: false,
  error: { code, message },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readSizeCategory(value: unknown): Dnd5eSizeCategory | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SIZE_CATEGORIES.includes(normalized as Dnd5eSizeCategory)
    ? normalized as Dnd5eSizeCategory
    : null;
}

function readStatBlockSize(statBlock: unknown): Dnd5eSizeCategory | null {
  if (!isRecord(statBlock)) return null;
  const direct = readSizeCategory(statBlock.size);
  if (direct) return direct;
  if (typeof statBlock.creatureType === 'string') {
    const match = /^\s*(tiny|small|medium|large|huge|gargantuan)\b/i.exec(statBlock.creatureType);
    if (match?.[1]) return readSizeCategory(match[1]);
  }
  return null;
}

function footprintSizeRange(footprint: MovementFootprintSize | undefined): Pick<MovementSizeResolution, 'minimum' | 'maximum'> | null {
  if (!footprint || !Number.isInteger(footprint.width) || footprint.width <= 0 || !Number.isInteger(footprint.height) || footprint.height <= 0) return null;
  if (footprint.width === 1 && footprint.height === 1) {
    // Tiny, Small and Medium creatures can all occupy one 5-foot square.
    return { minimum: 'tiny', maximum: 'medium' };
  }
  if (footprint.width === 2 && footprint.height === 2) return { minimum: 'large', maximum: 'large' };
  if (footprint.width === 3 && footprint.height === 3) return { minimum: 'huge', maximum: 'huge' };
  if (footprint.width >= 4 && footprint.height >= 4) return { minimum: 'gargantuan', maximum: 'gargantuan' };
  return null;
}

export function resolveDnd5eMovementSize(input: MovementSizeInput): MovementResult<MovementSizeResolution> {
  const explicit = readSizeCategory(input.sizeCategory);
  if (explicit) return { ok: true, minimum: explicit, maximum: explicit, source: 'explicit' };

  const statBlockSize = readStatBlockSize(input.statBlock);
  if (statBlockSize) return { ok: true, minimum: statBlockSize, maximum: statBlockSize, source: 'statBlock' };

  if (isRecord(input.characterData)) {
    const characterSize = readSizeCategory(input.characterData.sizeCategory) ?? readSizeCategory(input.characterData.size);
    if (characterSize) return { ok: true, minimum: characterSize, maximum: characterSize, source: 'characterData' };
  }

  if (isRecord(input.metadata)) {
    const metadataSize = readSizeCategory(input.metadata.sizeCategory) ?? readSizeCategory(input.metadata.size);
    if (metadataSize) return { ok: true, minimum: metadataSize, maximum: metadataSize, source: 'metadata' };
  }

  const footprint = footprintSizeRange(input.footprint);
  if (footprint) return { ok: true, ...footprint, source: 'footprint' };

  return failure('UNRESOLVED_SIZE', 'Creature size cannot be determined from its stat block, metadata, or footprint.');
}

interface ConditionSummary {
  restrained: boolean;
  grappled: boolean;
  immobilized: boolean;
  prone: boolean;
  exhaustionLevels: number[];
  bareExhaustion: boolean;
}

function parseConditionLevel(value: unknown): { condition: string; level?: number } | null {
  let name: unknown;
  let rawLevel: unknown;
  if (typeof value === 'string') {
    const normalized = value.trim();
    const match = /^(?:exhausted|exhaustion)(?:\s*(?:level)?\s*[:=#-]?\s*\(?\s*(\d+)\s*\)?)?$/i.exec(normalized);
    if (match) return { condition: 'exhausted', ...(match[1] ? { level: Number(match[1]) } : {}) };
    return { condition: normalized.toLowerCase() };
  }
  if (!isRecord(value)) return null;
  name = value.name ?? value.condition;
  rawLevel = value.level ?? value.exhaustionLevel;
  if (typeof name !== 'string') return null;
  const normalizedName = name.trim().toLowerCase();
  if (normalizedName !== 'exhausted' && normalizedName !== 'exhaustion') return { condition: normalizedName };
  return { condition: 'exhausted', ...(rawLevel !== undefined ? { level: Number(rawLevel) } : {}) };
}

function summarizeConditions(value: unknown): ConditionSummary {
  const summary: ConditionSummary = {
    restrained: false,
    grappled: false,
    immobilized: false,
    prone: false,
    exhaustionLevels: [],
    bareExhaustion: false,
  };
  if (!Array.isArray(value)) return summary;
  for (const entry of value) {
    const parsed = parseConditionLevel(entry);
    if (!parsed) continue;
    if (parsed.condition === 'restrained') summary.restrained = true;
    if (parsed.condition === 'grappled') summary.grappled = true;
    if (['paralyzed', 'petrified', 'stunned', 'unconscious'].includes(parsed.condition)) summary.immobilized = true;
    if (parsed.condition === 'prone') summary.prone = true;
    if (parsed.condition === 'exhausted') {
      if (parsed.level === undefined) summary.bareExhaustion = true;
      else summary.exhaustionLevels.push(parsed.level);
    }
  }
  return summary;
}

function explicitExhaustionLevel(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 6) return 'invalid';
  return value;
}

function pcExhaustionLevel(data: Record<string, unknown>): number | null | 'invalid' {
  const survival = isRecord(data.survival) ? data.survival : undefined;
  return explicitExhaustionLevel(survival?.exhaustionLevel ?? data.exhaustionLevel);
}

function npcExhaustionLevel(actor: Extract<MovementSpeedActor, { kind: 'npc' }>): number | null | 'invalid' {
  const statBlock = isRecord(actor.statBlock) ? actor.statBlock : undefined;
  const metadata = isRecord(actor.metadata) ? actor.metadata : undefined;
  return explicitExhaustionLevel(
    actor.exhaustionLevel ?? metadata?.exhaustionLevel ?? statBlock?.exhaustionLevel,
  );
}

function readWalkingSpeed(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string') {
    const segments = value.split(/[,;]/).map((segment) => segment.trim()).filter(Boolean);
    const explicitWalk = segments.find((segment) => /^(?:walk|walking)\b/i.test(segment));
    const explicitMatch = explicitWalk && /^(?:walk|walking)\s+(\d+)\s*(?:ft\.?|feet)(?:\s|$)/i.exec(explicitWalk);
    if (explicitMatch?.[1]) return Number(explicitMatch[1]);
    const defaultWalk = segments.find((segment) => /^\d+\s*(?:ft\.?|feet)(?:\s|$)/i.test(segment));
    const defaultMatch = defaultWalk && /^(\d+)\s*(?:ft\.?|feet)(?:\s|$)/i.exec(defaultWalk);
    if (defaultMatch?.[1]) return Number(defaultMatch[1]);
  }
  if (isRecord(value)) {
    const walk = value.walk ?? value.walking;
    if (typeof walk === 'number' && Number.isFinite(walk) && walk >= 0) return walk;
  }
  return null;
}

function resolveExhaustionLevel(
  actor: MovementSpeedActor,
  conditions: ConditionSummary,
): MovementResult<{ exhaustionLevel: number }> {
  let explicit: number | null | 'invalid';
  if (actor.kind === 'pc') {
    const data = isRecord(actor.characterData) ? actor.characterData : {};
    explicit = pcExhaustionLevel(data);
    if (explicit === null) {
      explicit = conditions.exhaustionLevels.length > 0
        ? conditions.exhaustionLevels[0]!
        : null;
    }
  } else {
    explicit = npcExhaustionLevel(actor);
    if (explicit === null) explicit = conditions.exhaustionLevels.length > 0 ? conditions.exhaustionLevels[0]! : null;
  }

  const allLevels = [
    ...(explicit === null || explicit === 'invalid' ? [] : [explicit]),
    ...conditions.exhaustionLevels,
  ];
  if (explicit === 'invalid' || allLevels.some((level) => !Number.isInteger(level) || level < 0 || level > 6)) {
    return failure('UNRESOLVED_EXHAUSTION_LEVEL', 'Exhaustion level must be an integer from 0 through 6.');
  }
  const distinctLevels = [...new Set(allLevels)];
  if (distinctLevels.length > 1) {
    return failure('UNRESOLVED_EXHAUSTION_LEVEL', 'The sheet and condition data disagree about the exhaustion level.');
  }
  if (conditions.bareExhaustion && distinctLevels.length === 0) {
    return failure('UNRESOLVED_EXHAUSTION_LEVEL', 'An Exhausted condition is present without a numeric exhaustion level.');
  }
  if (conditions.bareExhaustion && distinctLevels[0] === 0) {
    return failure('UNRESOLVED_EXHAUSTION_LEVEL', 'An Exhausted condition conflicts with exhaustion level 0.');
  }
  return { ok: true, exhaustionLevel: distinctLevels[0] ?? 0 };
}

function speedFromActor(actor: MovementSpeedActor): number | null {
  if (actor.kind === 'pc') {
    return isRecord(actor.characterData) ? readWalkingSpeed(actor.characterData.speed) : null;
  }
  return isRecord(actor.statBlock) ? readWalkingSpeed(actor.statBlock.speed) : null;
}

export function resolveDnd5eMovementSpeed(actor: MovementSpeedActor): MovementResult<{ speedFeet: number }> {
  const speed = speedFromActor(actor);
  if (speed === null) {
    return failure('UNRESOLVED_SPEED', 'Walking speed is missing or cannot be resolved from the character sheet or NPC stat block.');
  }

  let dataConditions: unknown;
  if (actor.kind === 'pc') {
    dataConditions = isRecord(actor.characterData) ? actor.characterData.conditions : actor.conditions;
  } else {
    dataConditions = actor.conditions;
  }
  const conditions = summarizeConditions(dataConditions);
  if (conditions.prone) {
    return failure('MOVEMENT_MODE_REQUIRED', 'A Prone creature must choose to crawl or stand up before movement can be planned.');
  }
  const exhaustion = resolveExhaustionLevel(actor, conditions);
  if (!exhaustion.ok) return exhaustion;

  let speedFeet = speed;
  if (exhaustion.exhaustionLevel >= 5) speedFeet = 0;
  else if (exhaustion.exhaustionLevel >= 2) speedFeet /= 2;
  if (conditions.restrained || conditions.grappled || conditions.immobilized) speedFeet = 0;
  return { ok: true, speedFeet };
}
