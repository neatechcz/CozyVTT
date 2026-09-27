import {
  resolveDnd5eMovementSize,
  resolveDnd5eMovementSpeed,
  type MovementSpeedActor,
  type MovementSizeInput,
} from './combatMovementSpeed';

export { resolveDnd5eMovementSize, resolveDnd5eMovementSpeed } from './combatMovementSpeed';
export type {
  Dnd5eSizeCategory,
  MovementSizeInput,
  MovementSizeResolution,
  MovementSpeedActor,
} from './combatMovementSpeed';

export interface GridPoint {
  x: number;
  y: number;
}

export type MovementDisposition = 'friendly' | 'neutral' | 'hostile';
export type MovementDiagonalRule = 'flat' | 'alternating';

export interface MovementFootprintSize {
  width: number;
  height: number;
}

export interface MovementToken {
  id: string;
  position: GridPoint;
  size: MovementFootprintSize;
  disposition?: MovementDisposition;
  sizeCategory?: import('./combatMovementSpeed').Dnd5eSizeCategory;
  statBlock?: unknown;
  metadata?: unknown;
  conditions?: unknown;
  type?: string;
}

export interface MovementWall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  type: 'wall' | 'door-closed' | 'door-open' | 'door-locked' | 'window';
}

export interface MovementMapSnapshot {
  width: number;
  height: number;
  gridSize: number;
  feetPerSquare: number;
  diagonalRule: MovementDiagonalRule;
  wallSegments: readonly MovementWall[];
  tokens: readonly MovementToken[];
  /** Grid cells covered by difficult terrain; omitted when the map has none. */
  difficultTerrain?: readonly GridPoint[];
}

export interface MovementLedger {
  turnId: string;
  tokenId: string;
  spentFeet: number;
  dashBonusFeet: number;
  /** Number of diagonal steps already taken this turn, across earlier moves. */
  diagonalStepsTaken: number;
}

export interface CombatMovementInput {
  tokenId: string;
  actor: MovementSpeedActor;
  destination: GridPoint;
  /** Ordered grid origins after the starting square; omitted to request a shortest route. */
  route?: readonly GridPoint[];
  map: MovementMapSnapshot;
  ledger: MovementLedger;
  activeTurn: { turnId: string; tokenId: string };
}

export type MovementErrorCode =
  | 'UNRESOLVED_SPEED'
  | 'UNRESOLVED_EXHAUSTION_LEVEL'
  | 'UNRESOLVED_SIZE'
  | 'MOVEMENT_MODE_REQUIRED'
  | 'TURN_MISMATCH'
  | 'INVALID_MOVEMENT_LEDGER'
  | 'INVALID_MAP_GEOMETRY'
  | 'INVALID_WALL_GEOMETRY'
  | 'INVALID_DIFFICULT_TERRAIN'
  | 'TOKEN_NOT_FOUND'
  | 'INVALID_TOKEN_GEOMETRY'
  | 'INVALID_ROUTE'
  | 'INVALID_DESTINATION'
  | 'OUT_OF_BOUNDS'
  | 'ROUTE_TOO_LONG'
  | 'PATH_SEARCH_LIMIT'
  | 'NON_ADJACENT_STEP'
  | 'ROUTE_DESTINATION_MISMATCH'
  | 'WALL_BLOCKED'
  | 'OCCUPIED_DESTINATION'
  | 'OBJECT_BLOCKED'
  | 'UNRESOLVED_OCCUPANT_RELATIONSHIP'
  | 'UNRESOLVED_SIZE_DIFFERENCE'
  | 'HOSTILE_OCCUPANT'
  | 'NO_PATH'
  | 'INSUFFICIENT_MOVEMENT';

export interface MovementError {
  code: MovementErrorCode;
  message: string;
  at?: GridPoint;
  tokenId?: string;
  blockingWallIds?: string[];
  blockingReasons?: MovementErrorCode[];
}

export type MovementResult<T> = { ok: true } & T | { ok: false; error: MovementError };

export interface MovementPlan {
  tokenId: string;
  turnId: string;
  start: GridPoint;
  destination: GridPoint;
  route: GridPoint[];
  speedFeet: number;
  movementCostFeet: number;
  movementSpentFeet: number;
  dashBonusFeet: number;
  diagonalStepsTaken: number;
  remainingMovementFeet: number;
}

interface GridWall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  blocksMovement: boolean;
}

interface NormalizedMap {
  width: number;
  height: number;
  feetPerSquare: number;
  diagonalRule: MovementDiagonalRule;
  wallBuckets: Map<string, GridWall[]>;
  broadWalls: GridWall[];
  difficultTerrain: Set<string>;
  occupants: Map<string, MovementToken[]>;
}

interface StepEvaluation {
  costFeet: number;
  diagonal: boolean;
}

const SIZE_ORDER: Record<import('./combatMovementSpeed').Dnd5eSizeCategory, number> = {
  tiny: 0,
  small: 1,
  medium: 2,
  large: 3,
  huge: 4,
  gargantuan: 5,
};

const MAX_MAP_CELLS = 1_000_000;
const MAX_AUTO_PATH_CELLS = 100_000;
const MAX_EXPLICIT_ROUTE_STEPS = 512;
const MAX_WALL_SEGMENTS = 5_000;
const MAX_MAP_TOKENS = 10_000;
const MAX_DIFFICULT_TERRAIN_CELLS = 100_000;
const MAX_WALL_BUCKET_REFERENCES = 1_000_000;
const MAX_WALLS_PER_BUCKET = 256;
const MAX_BROAD_WALLS = 64;
const MAX_TOKEN_FOOTPRINT_CELLS = 1_024;
const MAX_OCCUPANCY_REFERENCES = 100_000;

function failure(code: MovementErrorCode, message: string, extra: Partial<MovementError> = {}): MovementResult<never> {
  return { ok: false, error: { code, message, ...extra } };
}

function pointIsInteger(point: GridPoint): boolean {
  return Number.isInteger(point.x) && Number.isInteger(point.y);
}

function footprintIsValid(size: MovementFootprintSize): boolean {
  return Number.isInteger(size.width) && size.width > 0 && Number.isInteger(size.height) && size.height > 0;
}

function footprintInBounds(origin: GridPoint, size: MovementFootprintSize, map: Pick<NormalizedMap, 'width' | 'height'>): boolean {
  return (
    origin.x >= 0 && origin.y >= 0 &&
    origin.x + size.width <= map.width && origin.y + size.height <= map.height
  );
}

function footprintOverlaps(a: GridPoint, aSize: MovementFootprintSize, b: GridPoint, bSize: MovementFootprintSize): boolean {
  return (
    a.x <= b.x + bSize.width - 1 && b.x <= a.x + aSize.width - 1 &&
    a.y <= b.y + bSize.height - 1 && b.y <= a.y + aSize.height - 1
  );
}

function forEachFootprintCell(origin: GridPoint, size: MovementFootprintSize, visit: (cell: GridPoint) => boolean | void): boolean {
  for (let x = origin.x; x < origin.x + size.width; x++) {
    for (let y = origin.y; y < origin.y + size.height; y++) {
      if (visit({ x, y }) === false) return false;
    }
  }
  return true;
}

function orientation(a: GridPoint, b: GridPoint, c: GridPoint): number {
  const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(value) < 1e-9 ? 0 : Math.sign(value);
}

function withinBox(a: GridPoint, b: GridPoint, point: GridPoint): boolean {
  return (
    Math.min(a.x, b.x) - 1e-9 <= point.x && point.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= point.y && point.y <= Math.max(a.y, b.y) + 1e-9
  );
}

function segmentsIntersect(a: GridPoint, b: GridPoint, c: GridPoint, d: GridPoint): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && withinBox(a, b, c)) return true;
  if (o2 === 0 && withinBox(a, b, d)) return true;
  if (o3 === 0 && withinBox(c, d, a)) return true;
  if (o4 === 0 && withinBox(c, d, b)) return true;
  return false;
}

function normalizeMap(map: MovementMapSnapshot, movingTokenId: string): MovementResult<{ map: NormalizedMap }> {
  if (
    !Number.isInteger(map.width) || map.width <= 0 ||
    !Number.isInteger(map.height) || map.height <= 0 ||
    map.width * map.height > MAX_MAP_CELLS ||
    !Number.isInteger(map.gridSize) || map.gridSize <= 0 ||
    !Number.isInteger(map.feetPerSquare) || map.feetPerSquare <= 0 ||
    (map.diagonalRule !== 'flat' && map.diagonalRule !== 'alternating') ||
    !Array.isArray(map.wallSegments) || map.wallSegments.length > MAX_WALL_SEGMENTS ||
    !Array.isArray(map.tokens) || map.tokens.length > MAX_MAP_TOKENS ||
    (map.difficultTerrain !== undefined && !Array.isArray(map.difficultTerrain))
  ) {
    return failure('INVALID_MAP_GEOMETRY', 'Map bounds, grid scale, diagonal rule, walls, or tokens are invalid.');
  }

  const walls: GridWall[] = [];
  for (const wall of map.wallSegments) {
    if (
      !wall || typeof wall.id !== 'string' ||
      ![wall.x1, wall.y1, wall.x2, wall.y2].every(Number.isFinite) ||
      !['wall', 'door-closed', 'door-open', 'door-locked', 'window'].includes(wall.type)
    ) {
      return failure('INVALID_WALL_GEOMETRY', 'A map wall has invalid coordinates or type.');
    }
    // Stored wall coordinates use map pixels with a top-left origin. Token and
    // route positions use grid squares with a bottom-left origin.
    walls.push({
      id: wall.id,
      x1: wall.x1 / map.gridSize,
      y1: map.height - wall.y1 / map.gridSize,
      x2: wall.x2 / map.gridSize,
      y2: map.height - wall.y2 / map.gridSize,
      blocksMovement: wall.type !== 'door-open',
    });
  }

  const wallBuckets = new Map<string, GridWall[]>();
  const broadWalls: GridWall[] = [];
  let wallBucketReferences = 0;
  for (const wall of walls) {
    if (!wall.blocksMovement) continue;
    const minX = Math.max(0, Math.floor(Math.min(wall.x1, wall.x2)) - 1);
    const maxX = Math.min(map.width - 1, Math.ceil(Math.max(wall.x1, wall.x2)));
    const minY = Math.max(0, Math.floor(Math.min(wall.y1, wall.y2)) - 1);
    const maxY = Math.min(map.height - 1, Math.ceil(Math.max(wall.y1, wall.y2)));
    const bucketArea = Math.max(0, maxX - minX + 1) * Math.max(0, maxY - minY + 1);
    if (bucketArea > 1_000) {
      broadWalls.push(wall);
      if (broadWalls.length > MAX_BROAD_WALLS) {
        return failure('INVALID_WALL_GEOMETRY', 'Too many map walls span a large area for bounded movement planning.');
      }
      continue;
    }
    wallBucketReferences += bucketArea;
    if (wallBucketReferences > MAX_WALL_BUCKET_REFERENCES) {
      return failure('INVALID_WALL_GEOMETRY', 'Wall geometry exceeds the movement planner indexing limit.');
    }
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const key = cellKey({ x, y });
        const list = wallBuckets.get(key);
        if (list) {
          if (list.length >= MAX_WALLS_PER_BUCKET) {
            return failure('INVALID_WALL_GEOMETRY', 'Too many wall segments overlap one movement cell.');
          }
          list.push(wall);
        } else {
          wallBuckets.set(key, [wall]);
        }
      }
    }
  }

  const difficultTerrain = new Set<string>();
  if ((map.difficultTerrain?.length ?? 0) > MAX_DIFFICULT_TERRAIN_CELLS) {
    return failure('INVALID_DIFFICULT_TERRAIN', 'The difficult terrain list exceeds its safe size limit.');
  }
  for (const cell of map.difficultTerrain ?? []) {
    if (!cell || typeof cell !== 'object' || !pointIsInteger(cell) || cell.x < 0 || cell.y < 0 || cell.x >= map.width || cell.y >= map.height) {
      return failure('INVALID_DIFFICULT_TERRAIN', 'A difficult terrain entry must identify a grid cell inside the map.');
    }
    difficultTerrain.add(cellKey(cell));
  }

  const occupants = new Map<string, MovementToken[]>();
  let occupancyReferences = 0;
  for (const token of map.tokens) {
    if (
      !token || typeof token.id !== 'string' || token.id.length === 0 ||
      !token.position || !token.size || !pointIsInteger(token.position) || !footprintIsValid(token.size) ||
      token.size.width > map.width || token.size.height > map.height ||
      token.size.width * token.size.height > MAX_TOKEN_FOOTPRINT_CELLS
    ) {
      return failure('INVALID_TOKEN_GEOMETRY', 'A token on the map has invalid position or footprint data.');
    }
    if (token.id === movingTokenId) continue;
    // Index only map cells occupied by another token. Off-map portions of an
    // already placed token cannot collide with an in-bounds movement step.
    const minX = Math.max(0, token.position.x);
    const minY = Math.max(0, token.position.y);
    const maxX = Math.min(map.width, token.position.x + token.size.width);
    const maxY = Math.min(map.height, token.position.y + token.size.height);
    for (let x = minX; x < maxX; x++) {
      for (let y = minY; y < maxY; y++) {
        const key = cellKey({ x, y });
        const list = occupants.get(key);
        if (list) list.push(token);
        else occupants.set(key, [token]);
        occupancyReferences++;
        if (occupancyReferences > MAX_OCCUPANCY_REFERENCES) {
          return failure('INVALID_TOKEN_GEOMETRY', 'Token occupancy data exceeds the movement planner indexing limit.');
        }
      }
    }
  }

  return {
    ok: true,
    map: {
      width: map.width,
      height: map.height,
      feetPerSquare: map.feetPerSquare,
      diagonalRule: map.diagonalRule,
      wallBuckets,
      broadWalls,
      difficultTerrain,
      occupants,
    },
  };
}

function cellKey(point: GridPoint): string {
  return `${point.x},${point.y}`;
}

function wallCrossings(from: GridPoint, to: GridPoint, size: MovementFootprintSize, map: NormalizedMap): string[] {
  const crossed: string[] = [];
  const candidates = new Set<GridWall>();
  forEachFootprintCell(from, size, (cell) => {
    for (const wall of map.wallBuckets.get(cellKey(cell)) ?? []) candidates.add(wall);
    for (const wall of map.broadWalls) candidates.add(wall);
  });
  forEachFootprintCell(from, size, (cell) => {
    const fromCenter = { x: cell.x + 0.5, y: cell.y + 0.5 };
    const toCenter = { x: cell.x + to.x - from.x + 0.5, y: cell.y + to.y - from.y + 0.5 };
    for (const wall of candidates) {
      if (
        wall.blocksMovement &&
        segmentsIntersect(fromCenter, toCenter, { x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }) &&
        !crossed.includes(wall.id)
      ) crossed.push(wall.id);
    }
    return true;
  });
  return crossed;
}

function resolveDisposition(mover: MovementToken, actor: MovementSpeedActor): MovementDisposition | undefined {
  if (mover.disposition) return mover.disposition;
  return actor.kind === 'pc' ? 'friendly' : undefined;
}

function hostilityBetween(a: MovementDisposition | undefined, b: MovementDisposition | undefined): boolean | null {
  if (!a || !b) return null;
  return (a === 'hostile') !== (b === 'hostile');
}

function resolveTokenSize(token: MovementToken, actor?: MovementSpeedActor) {
  const actorSize: MovementSizeInput = actor?.kind === 'pc'
    ? { characterData: actor.characterData }
    : actor?.kind === 'npc'
      ? { statBlock: actor.statBlock }
      : {};
  return resolveDnd5eMovementSize({
    sizeCategory: token.sizeCategory,
    statBlock: token.statBlock ?? (actor?.kind === 'npc' ? actor.statBlock : undefined),
    characterData: actorSize.characterData,
    metadata: token.metadata,
    footprint: token.size,
  });
}

function minimumSizeDifference(
  a: { minimum: import('./combatMovementSpeed').Dnd5eSizeCategory; maximum: import('./combatMovementSpeed').Dnd5eSizeCategory },
  b: { minimum: import('./combatMovementSpeed').Dnd5eSizeCategory; maximum: import('./combatMovementSpeed').Dnd5eSizeCategory },
): { minimum: number; maximum: number } {
  const amin = SIZE_ORDER[a.minimum];
  const amax = SIZE_ORDER[a.maximum];
  const bmin = SIZE_ORDER[b.minimum];
  const bmax = SIZE_ORDER[b.maximum];
  const minimum = amax < bmin ? bmin - amax : bmax < amin ? amin - bmax : 0;
  const maximum = Math.max(Math.abs(amin - bmax), Math.abs(amax - bmin));
  return { minimum, maximum };
}

function evaluateStep(
  from: GridPoint,
  to: GridPoint,
  diagonalParity: number,
  isFinal: boolean,
  mover: MovementToken,
  actor: MovementSpeedActor,
  map: NormalizedMap,
): MovementResult<StepEvaluation> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!Number.isInteger(dx) || !Number.isInteger(dy) || Math.max(Math.abs(dx), Math.abs(dy)) !== 1) {
    return failure('NON_ADJACENT_STEP', 'Each route step must move to one adjacent grid origin.', { at: to });
  }
  if (!footprintInBounds(to, mover.size, map)) {
    return failure('OUT_OF_BOUNDS', 'The token footprint would leave the map.', { at: to });
  }

  const blockingWallIds = wallCrossings(from, to, mover.size, map);
  if (blockingWallIds.length > 0) {
    return failure('WALL_BLOCKED', 'The route crosses a wall or closed door.', { at: to, blockingWallIds });
  }

  let passesCreature = false;
  const overlapping = new Map<string, MovementToken>();
  forEachFootprintCell(to, mover.size, (cell) => {
    for (const other of map.occupants.get(cellKey(cell)) ?? []) overlapping.set(other.id, other);
  });
  for (const other of overlapping.values()) {
    if (!footprintOverlaps(to, mover.size, other.position, other.size)) continue;
    if (isFinal) {
      return failure('OCCUPIED_DESTINATION', 'A token cannot end movement in another token’s space.', { at: to, tokenId: other.id });
    }
    if (other.type === 'object') {
      return failure('OBJECT_BLOCKED', 'The route cannot pass through an object token.', { at: to, tokenId: other.id });
    }

    const hostile = hostilityBetween(resolveDisposition(mover, actor), other.disposition);
    if (hostile === null) {
      return failure(
        'UNRESOLVED_OCCUPANT_RELATIONSHIP',
        'Cannot determine whether the occupied space belongs to a hostile creature; movement was rejected.',
        { at: to, tokenId: other.id },
      );
    }
    if (hostile) {
      const moverSize = resolveTokenSize(mover, actor);
      const otherSize = resolveTokenSize(other);
      if (!moverSize.ok || !otherSize.ok) {
        return failure(
          'UNRESOLVED_SIZE_DIFFERENCE',
          'Cannot determine whether the hostile creature is at least two size categories larger or smaller.',
          { at: to, tokenId: other.id },
        );
      }
      const difference = minimumSizeDifference(moverSize, otherSize);
      if (difference.minimum < 2) {
        if (difference.maximum >= 2) {
          return failure(
            'UNRESOLVED_SIZE_DIFFERENCE',
            'The available size data cannot prove the two-category difference required to pass a hostile creature.',
            { at: to, tokenId: other.id },
          );
        }
        return failure('HOSTILE_OCCUPANT', 'A creature may pass through a hostile creature only when their sizes differ by at least two categories.', {
          at: to,
          tokenId: other.id,
        });
      }
    }
    passesCreature = true;
  }

  let difficult = passesCreature;
  forEachFootprintCell(to, mover.size, (cell) => {
    if (map.difficultTerrain.has(cellKey(cell))) difficult = true;
  });

  const diagonal = dx !== 0 && dy !== 0;
  const baseCost = diagonal && map.diagonalRule === 'alternating'
    ? (diagonalParity === 0 ? map.feetPerSquare : map.feetPerSquare * 2)
    : map.feetPerSquare;
  return { ok: true, costFeet: baseCost * (difficult ? 2 : 1), diagonal };
}

class MinHeap {
  private readonly items: Array<{ cost: number; state: number }> = [];

  get size(): number {
    return this.items.length;
  }

  push(cost: number, state: number): void {
    this.items.push({ cost, state });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent]!.cost <= this.items[i]!.cost) break;
      [this.items[parent], this.items[i]] = [this.items[i]!, this.items[parent]!];
      i = parent;
    }
  }

  pop(): { cost: number; state: number } | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.items[left]!.cost < this.items[smallest]!.cost) smallest = left;
        if (right < this.items.length && this.items[right]!.cost < this.items[smallest]!.cost) smallest = right;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i]!, this.items[smallest]!];
        i = smallest;
      }
    }
    return top;
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function findShortestRoute(
  start: GridPoint,
  destination: GridPoint,
  diagonalStepsTaken: number,
  mover: MovementToken,
  actor: MovementSpeedActor,
  map: NormalizedMap,
): MovementResult<{ route: GridPoint[] }> {
  if (start.x === destination.x && start.y === destination.y) return { ok: true, route: [] };

  const cells = map.width * map.height;
  if (cells > MAX_AUTO_PATH_CELLS) {
    return failure('PATH_SEARCH_LIMIT', `Automatic route search is limited to ${MAX_AUTO_PATH_CELLS} map cells.`);
  }
  const stateCount = cells * 2;
  const best = new Float64Array(stateCount).fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(stateCount).fill(-1);
  const heap = new MinHeap();
  const startParity = diagonalStepsTaken % 2;
  const startState = (start.y * map.width + start.x) * 2 + startParity;
  best[startState] = 0;
  heap.push(0, startState);
  const blockingReasons = new Set<MovementErrorCode>();

  while (heap.size > 0) {
    const current = heap.pop()!;
    if (current.cost > best[current.state]!) continue;
    const square = current.state >> 1;
    const parity = current.state & 1;
    const x = square % map.width;
    const y = Math.floor(square / map.width);
    if (x === destination.x && y === destination.y) {
      const route: GridPoint[] = [];
      let state = current.state;
      while (state !== startState) {
        route.push({ x: (state >> 1) % map.width, y: Math.floor((state >> 1) / map.width) });
        state = previous[state]!;
        if (state < 0) return failure('NO_PATH', 'No legal route reaches the destination.');
      }
      route.reverse();
      return { ok: true, route };
    }

    for (const [dx, dy] of NEIGHBOURS) {
      const next = { x: x + dx, y: y + dy };
      if (!footprintInBounds(next, mover.size, map)) continue;
      const evaluation = evaluateStep(
        { x, y }, next, parity, next.x === destination.x && next.y === destination.y,
        mover, actor, map,
      );
      if (!evaluation.ok) {
        blockingReasons.add(evaluation.error.code);
        continue;
      }
      const nextParity = evaluation.diagonal ? parity ^ 1 : parity;
      const nextState = (next.y * map.width + next.x) * 2 + nextParity;
      const nextCost = current.cost + evaluation.costFeet;
      if (nextCost < best[nextState]!) {
        best[nextState] = nextCost;
        previous[nextState] = current.state;
        heap.push(nextCost, nextState);
      }
    }
  }

  return failure('NO_PATH', 'No legal route reaches the destination.', { blockingReasons: [...blockingReasons] });
}

export function planCombatMovement(input: CombatMovementInput): MovementResult<MovementPlan> {
  if (
    input.ledger.turnId !== input.activeTurn.turnId ||
    input.ledger.turnId.length === 0 ||
    input.ledger.tokenId !== input.tokenId ||
    input.activeTurn.tokenId !== input.tokenId
  ) {
    return failure('TURN_MISMATCH', 'Movement ledger does not belong to the active token and initiative turn.');
  }
  if (
    !Number.isFinite(input.ledger.spentFeet) || input.ledger.spentFeet < 0 ||
    !Number.isFinite(input.ledger.dashBonusFeet) || input.ledger.dashBonusFeet < 0 ||
    !Number.isSafeInteger(input.ledger.diagonalStepsTaken) || input.ledger.diagonalStepsTaken < 0
  ) {
    return failure('INVALID_MOVEMENT_LEDGER', 'The turn movement ledger contains an invalid value.');
  }

  if (!input.map || !Array.isArray(input.map.tokens)) {
    return failure('INVALID_MAP_GEOMETRY', 'Map tokens are not available as an array.');
  }
  const mover = input.map.tokens.find((token) => token?.id === input.tokenId);
  if (!mover) return failure('TOKEN_NOT_FOUND', 'The moving token is not on this map.', { tokenId: input.tokenId });
  const normalized = normalizeMap(input.map, input.tokenId);
  if (!normalized.ok) return normalized;
  if (!mover.position || !mover.size || !pointIsInteger(mover.position) || !footprintIsValid(mover.size)) {
    return failure('INVALID_TOKEN_GEOMETRY', 'The moving token has invalid position or footprint data.', { tokenId: mover.id });
  }
  const start = mover.position;
  if (!pointIsInteger(input.destination)) {
    return failure('INVALID_DESTINATION', 'The destination must be an integer grid origin.', { at: input.destination });
  }
  if (!footprintInBounds(start, mover.size, normalized.map)) {
    return failure('OUT_OF_BOUNDS', 'The moving token starts outside the map bounds.', { at: start });
  }
  if (!footprintInBounds(input.destination, mover.size, normalized.map)) {
    return failure('OUT_OF_BOUNDS', 'The destination footprint would leave the map.', { at: input.destination });
  }
  const destinationOccupants = new Map<string, MovementToken>();
  forEachFootprintCell(input.destination, mover.size, (cell) => {
    for (const occupant of normalized.map.occupants.get(cellKey(cell)) ?? []) destinationOccupants.set(occupant.id, occupant);
  });
  const destinationOccupant = [...destinationOccupants.values()].find((occupant) =>
    footprintOverlaps(input.destination, mover.size, occupant.position, occupant.size));
  if (destinationOccupant) {
    return failure('OCCUPIED_DESTINATION', 'A token cannot end movement in another token’s space.', {
      at: input.destination,
      tokenId: destinationOccupant.id,
    });
  }

  const actorForSpeed: MovementSpeedActor = input.actor.kind === 'pc'
    ? input.actor
    : {
      ...input.actor,
      conditions: input.actor.conditions ?? mover.conditions,
      metadata: input.actor.metadata ?? mover.metadata,
    };
  const speed = resolveDnd5eMovementSpeed(actorForSpeed);
  if (!speed.ok) return speed;

  let route: GridPoint[];
  if (input.route !== undefined) {
    if (input.route.length > MAX_EXPLICIT_ROUTE_STEPS) {
      return failure('ROUTE_TOO_LONG', `An explicit route may contain at most ${MAX_EXPLICIT_ROUTE_STEPS} steps.`);
    }
    route = [...input.route];
    if (route.some((point) => !point || typeof point !== 'object' || !pointIsInteger(point))) {
      return failure('INVALID_ROUTE', 'Every route step must be an integer grid origin.');
    }
    const last = route[route.length - 1];
    if ((last?.x ?? start.x) !== input.destination.x || (last?.y ?? start.y) !== input.destination.y) {
      return failure('ROUTE_DESTINATION_MISMATCH', 'The final route origin must match the requested destination.', { at: input.destination });
    }
  } else {
    const found = findShortestRoute(
      start,
      input.destination,
      input.ledger.diagonalStepsTaken,
      mover,
      input.actor,
      normalized.map,
    );
    if (!found.ok) return found;
    route = found.route;
  }

  let from = start;
  let movementCostFeet = 0;
  let diagonalStepsTaken = input.ledger.diagonalStepsTaken;
  for (const to of route) {
    const step = evaluateStep(
      from,
      to,
      diagonalStepsTaken % 2,
      to.x === input.destination.x && to.y === input.destination.y,
      mover,
      input.actor,
      normalized.map,
    );
    if (!step.ok) return step;
    movementCostFeet += step.costFeet;
    if (step.diagonal) diagonalStepsTaken++;
    from = to;
  }

  const movementSpentFeet = input.ledger.spentFeet + movementCostFeet;
  const remainingMovementFeet = speed.speedFeet + input.ledger.dashBonusFeet - movementSpentFeet;
  if (remainingMovementFeet < 0) {
    return failure(
      'INSUFFICIENT_MOVEMENT',
      `This route costs ${movementCostFeet} ft., but only ${Math.max(0, speed.speedFeet + input.ledger.dashBonusFeet - input.ledger.spentFeet)} ft. remain this turn.`,
      { at: input.destination },
    );
  }

  return {
    ok: true,
    tokenId: input.tokenId,
    turnId: input.ledger.turnId,
    start: { ...start },
    destination: { ...input.destination },
    route,
    speedFeet: speed.speedFeet,
    movementCostFeet,
    movementSpentFeet,
    dashBonusFeet: input.ledger.dashBonusFeet,
    diagonalStepsTaken,
    remainingMovementFeet,
  };
}
