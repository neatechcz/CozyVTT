// ============================================
// Token movement handlers
// token.move.start / token.move (throttled) / token.move.end
// ============================================

import { Server } from 'socket.io';
import { throttle } from 'lodash';
import { randomUUID } from 'crypto';
import { AuthenticatedSocket } from '../auth';
import { prisma } from '../../config/database';
import {
  diffTokenViews,
  filterTokensForViewer,
  getSpiritVisibility,
  getTokenViewersFor,
  tokenViewerKey,
  withLightPolygons,
  type TokenViewer,
  type TokenViewMap,
} from '../../utils/spirit-layer';
import logger from '../../utils/logger';
import { Token, tokenMoveLimiter } from '../shared';
import { bumpMapVersion, getMapVersion } from '../mapVersion';
import { readCombatState, type MovementLedger } from '../initiativeState';
import {
  planCombatMovement,
  type GridPoint,
  type MovementToken,
  type MovementSpeedActor,
} from '../../services/combatMovement';
import {
  loadCampaignCombatState,
  saveCampaignCombatState,
  withCampaignMapRowLock,
} from '../../services/combatStatePersistence';


/** A socket in the campaign room with the inputs of its token view. */
interface RoomViewer {
  socket: { id: string; emit: (event: string, payload: unknown) => unknown };
  viewer: TokenViewer;
}

/** The map fields a drag needs: bounds, campaign, tokens and the lighting inputs. */
const DRAG_MAP_SELECT = {
  campaignId: true,
  width: true,
  height: true,
  gridSize: true,
  tokens: true,
  lightingEnabled: true,
  wallSegments: true,
  lights: true,
} as const;

/** How long a drag reuses its map snapshot and viewers without a new read. */
export const DRAG_CONTEXT_TTL_MS = 500;

/** Every socket in the campaign room with its TokenViewer (role, plane, own characters). */
async function getRoomViewers(io: Server, campaignId: string): Promise<RoomViewer[]> {
  const campaignSockets = await io.in(campaignId).fetchSockets();
  return getTokenViewersFor(
    campaignId,
    campaignSockets.map((s) => s as unknown as AuthenticatedSocket)
  );
}

/**
 * A viewer's filtered view of a token array (filterTokensForViewer: role and
 * spirit plane, then line of sight on lighting maps), memoised per
 * (array, viewer) so a user's sockets share one computation.
 */
function tokenViewCache(map: TokenViewMap) {
  const cache = new Map<unknown[], Map<string, Token[]>>();
  return (tokens: Token[], viewer: TokenViewer): Token[] => {
    let byViewer = cache.get(tokens);
    if (!byViewer) cache.set(tokens, (byViewer = new Map()));
    const key = tokenViewerKey(viewer);
    let view = byViewer.get(key);
    if (!view) {
      view = filterTokensForViewer(tokens, map, viewer) as unknown as Token[];
      byViewer.set(key, view);
    }
    return view;
  };
}

/** Whether every campaign member sees this token without per-viewer filtering. */
function isPublicToken(map: TokenViewMap, token: Token | undefined): boolean {
  return !map.lightingEnabled && !!token && token.visible && token.layer === 'token';
}

/**
 * Emit a token-scoped event (`token.move.start`, `token.moved`) to the DMs
 * and to every other socket whose view of `tokens` contains the token — the
 * same per-recipient rules as map.changed (filterTokensForViewer).
 *
 * Shortcut: a visible material-plane token on a map without dynamic lighting
 * goes to every vetted socket in one emit, but only when every non-DM viewer
 * has a userId and sees the material plane (nobody is in the spirit realm,
 * where only spirit-layer tokens are visible) — then each of them would
 * receive it anyway. The emit targets the vetted socket ids, never the room:
 * viewers may be cached (DRAG_CONTEXT_TTL_MS), and a socket that joined since
 * was not vetted. Otherwise every viewer is checked.
 */
async function emitToTokenViewers(
  io: Server,
  sender: AuthenticatedSocket,
  map: TokenViewMap,
  tokens: Token[],
  tokenId: string,
  event: string,
  payload: unknown,
  { excludeSender, viewers }: { excludeSender: boolean; viewers: () => Promise<RoomViewer[]> }
): Promise<string[]> {
  const roomViewers = await viewers();
  const everyPlayerSeesMaterialPlane = roomViewers.every(
    ({ viewer }) => viewer.role === 'DM' || (!!viewer.userId && !viewer.spiritVisible)
  );
  if (everyPlayerSeesMaterialPlane && isPublicToken(map, tokens.find((t) => t.id === tokenId))) {
    const socketIds = roomViewers
      .map(({ socket }) => socket.id)
      .filter((id) => !(excludeSender && id === sender.id));
    // io.to([]) would broadcast to the whole namespace.
    if (socketIds.length > 0) io.to(socketIds).emit(event, payload);
    return socketIds;
  }

  const view = tokenViewCache(map);
  const recipientIds: string[] = [];
  for (const { socket, viewer } of roomViewers) {
    if (excludeSender && socket.id === sender.id) continue;
    if (viewer.role === 'DM' || view(tokens, viewer).some((t) => t.id === tokenId)) {
      socket.emit(event, payload);
      recipientIds.push(socket.id);
    }
  }
  return recipientIds;
}

type FrameData = { tokenId: string; mapId: string; x: number; y: number };
type MoveRequest = FrameData & {
  requestId?: unknown;
  route?: unknown;
  override?: unknown;
};

interface MovementWire {
  tokenId: string;
  turnId: string;
  speedFeet: number | null;
  movementCostFeet: number;
  spentFeet: number;
  remainingMovementFeet: number | null;
  dashBonusFeet: number;
  dashUsed: boolean;
  diagonalStepsTaken: number;
  route: GridPoint[];
  override: boolean;
}

interface MoveWireBase {
  requestId: string;
  tokenId: string;
  mapId: string;
  position: GridPoint | null;
  movement: MovementWire | null;
}

type MoveTransactionResult =
  | {
    ok: true;
    activeCombat: boolean;
    map: TokenViewMap;
    previousTokens: Token[];
    updatedTokens: Token[];
    token: Token;
    movement: MovementWire | null;
    position: GridPoint;
  }
  | { ok: false; message: string; code?: string }
  | { ok: false; rejected: MoveWireBase & { error: { code: string; message: string } } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function movementWireFromLedger(ledger: MovementLedger | null): MovementWire | null {
  if (!ledger) return null;
  return {
    tokenId: ledger.tokenId,
    turnId: ledger.turnId,
    speedFeet: ledger.speedFeet,
    movementCostFeet: 0,
    spentFeet: ledger.spentFeet,
    remainingMovementFeet: ledger.remainingMovementFeet,
    dashBonusFeet: ledger.dashBonusFeet,
    dashUsed: ledger.dashUsed,
    diagonalStepsTaken: ledger.diagonalStepsTaken,
    route: [],
    override: false,
  };
}

function validGridPoint(value: unknown): value is GridPoint {
  return isRecord(value) && typeof value.x === 'number' && Number.isInteger(value.x) &&
    typeof value.y === 'number' && Number.isInteger(value.y);
}

function emitMoveRejection(
  io: Server,
  socket: AuthenticatedSocket,
  previewedSocketIds: Set<string>,
  payload: MoveWireBase & { error: { code: string; message: string } }
): void {
  socket.emit('token.move.rejected', payload);
  const recipientIds = [...new Set([socket.id, ...previewedSocketIds])];
  if (recipientIds.length > 0) {
    io.to(recipientIds).emit('token.move.preview', {
      requestId: payload.requestId,
      tokenId: payload.tokenId,
      mapId: payload.mapId,
      ...(payload.position ? { x: payload.position.x, y: payload.position.y, position: payload.position } : {}),
      preview: false,
      movedBy: socket.userId,
    });
  }
  previewedSocketIds.clear();
}

/** What one drag reuses between frames: the map snapshot and the room's viewers. */
interface DragContext {
  mapId: string;
  /** getMapVersion(mapId) when loaded: a later map write invalidates the context. */
  version: number;
  map: TokenViewMap & { campaignId: string; tokens: unknown };
  viewers: () => Promise<RoomViewer[]>;
  expiresAt: number;
}

export function registerTokenHandlers(io: Server, socket: AuthenticatedSocket): void {
  // ── Per-socket drag state ────────────────────────────────────────────────
  // The map snapshot (bounds, tokens, walls, lights with their light polygons)
  // and the room's viewers are resolved once per drag and reused until
  // token.move.end, for at most DRAG_CONTEXT_TTL_MS, and only while the map's
  // in-process version (mapVersion.ts) is unchanged — any map writer bumps it,
  // so the next frame reloads.
  let drag: DragContext | null = null;
  // Frames are processed one at a time, in order; while one is processed only
  // the newest waiting frame is kept (stale frames are dropped, never queued).
  let frameInFlight: Promise<void> | null = null;
  let pendingFrame: FrameData | null = null;
  let lastFrame: FrameData | null = null;
  const previewedSocketIds = new Set<string>();

  async function loadDragContext(mapId: string): Promise<DragContext | null> {
    if (drag && drag.mapId === mapId && drag.version === getMapVersion(mapId) && Date.now() < drag.expiresAt) {
      return drag;
    }
    const version = getMapVersion(mapId);
    const map = await prisma.map.findUnique({ where: { id: mapId }, select: DRAG_MAP_SELECT });
    if (!map || map.campaignId !== socket.campaignId) {
      drag = null;
      return null;
    }
    let viewers: Promise<RoomViewer[]> | null = null;
    const campaignId = socket.campaignId!;
    drag = {
      mapId,
      version,
      map: withLightPolygons(map),
      // Resolved once per drag context, on first use.
      viewers: () => (viewers ??= getRoomViewers(io, campaignId)),
      expiresAt: Date.now() + DRAG_CONTEXT_TTL_MS,
    };
    return drag;
  }

  /**
   * TOKEN.MOVE.START - User begins dragging a token
   * Validates permission and broadcasts to campaign
   */
  socket.on('token.move.start', async (data: { tokenId: string; mapId: string }) => {
    try {
      if (!socket.campaignId) {
        socket.emit('error', { message: 'Not authenticated to a campaign' });
        return;
      }

      const { tokenId, mapId } = data;

      if (!tokenId || !mapId) {
        socket.emit('error', { message: 'tokenId and mapId required' });
        return;
      }

      // A new drag starts from a fresh map snapshot.
      drag = null;
      lastFrame = null;
      previewedSocketIds.clear();
      const ctx = await loadDragContext(mapId);

      if (!ctx) {
        socket.emit('error', { message: 'Map not found' });
        return;
      }

      // Get tokens array
      const tokensArray = (Array.isArray(ctx.map.tokens) ? ctx.map.tokens : []) as unknown as Token[];
      const token = tokensArray.find((t) => t.id === tokenId);

      if (!token) {
        socket.emit('error', { message: 'Token not found' });
        return;
      }

      const campaign = await prisma.campaign.findUnique({
        where: { id: socket.campaignId },
        select: { gameSystem: true, combatState: true },
      });
      const combatState = readCombatState(campaign?.combatState);
      if (combatState.active && (
        campaign?.gameSystem !== 'DND_5E' ||
        combatState.mapId !== mapId ||
        combatState.currentTokenId !== tokenId
      )) {
        // Drag previews are not a way to move inactive combatants.
        return;
      }

      // Permission check: DM can move any token, players can only move their own
      if (socket.role !== 'DM' && token.controlledBy !== socket.userId) {
        socket.emit('error', { message: 'You do not have permission to move this token' });
        return;
      }

      // Spectators cannot move tokens (already handled by controlledBy check, but explicit)
      if (socket.role === 'SPECTATOR') {
        socket.emit('error', { message: 'Spectators cannot move tokens' });
        return;
      }

      // Spirit layer check: non-DMs cannot interact with spirit tokens when spirit layer is disabled
      if (token.layer === 'spirit' && socket.role !== 'DM') {
        const spiritVisible = await getSpiritVisibility(socket.campaignId, socket.userId!);
        if (!spiritVisible) {
          socket.emit('error', { message: 'You cannot interact with spirit layer tokens' });
          return;
        }
      }

      // Only DMs and sockets that can see the token learn that it is being dragged.
      await emitToTokenViewers(
        io,
        socket,
        ctx.map,
        tokensArray,
        tokenId,
        'token.move.start',
        { tokenId, mapId, movedBy: socket.userId },
        { excludeSender: true, viewers: ctx.viewers }
      );

      logger.debug('token.move.start', { tokenId, userId: socket.userId, mapId });
    } catch (error) {
      logger.error('token.move.start failed', { err: error });
      socket.emit('error', { message: 'Failed to start token movement' });
    }
  });

  /**
   * One drag frame: validate, then send `token.moved` to the sockets that see
   * the token at its new cell. Runs from the per-socket frame queue only.
   */
  async function processFrame(data: FrameData): Promise<void> {
    try {
      if (!socket.campaignId) {
        return; // Silently ignore if not authenticated
      }

      const { tokenId, mapId, x, y } = data;

      if (!tokenId || !mapId || typeof x !== 'number' || !Number.isInteger(x) ||
          typeof y !== 'number' || !Number.isInteger(y)) {
        return; // Silently ignore invalid data during rapid updates
      }

      // Same token, same cell as this socket's last frame: nothing to send.
      if (
        lastFrame &&
        lastFrame.tokenId === tokenId &&
        lastFrame.mapId === mapId &&
        lastFrame.x === x &&
        lastFrame.y === y
      ) {
        return;
      }

      // Flood ceiling: drop excess frames silently — the 16ms throttle
      // already paces legitimate drags well under this limit.
      if (!tokenMoveLimiter.check(socket.id, 150, 1000)) {
        return;
      }

      // One map read per drag (or per DRAG_CONTEXT_TTL_MS), not per frame.
      const ctx = await loadDragContext(mapId);
      if (!ctx) {
        return; // Silently ignore invalid map during rapid updates
      }

      // Validate coordinates are within map bounds
      // The frame's position decides who sees it (line of sight on lighting maps).
      const storedTokens = (Array.isArray(ctx.map.tokens) ? ctx.map.tokens : []) as unknown as Token[];
      const movingToken = storedTokens.find((t) => t.id === tokenId);
      if (!movingToken || socket.role === 'SPECTATOR' ||
          (socket.role !== 'DM' && movingToken.controlledBy !== socket.userId)) {
        return;
      }
      if (!isRecord(movingToken.size) || !Number.isInteger(movingToken.size.width) ||
          Number(movingToken.size.width) < 1 || !Number.isInteger(movingToken.size.height) ||
          Number(movingToken.size.height) < 1 || x < 0 || y < 0 ||
          x + Number(movingToken.size.width) > ctx.map.width ||
          y + Number(movingToken.size.height) > ctx.map.height) {
        return;
      }

      const campaign = await prisma.campaign.findUnique({
        where: { id: socket.campaignId },
        select: { gameSystem: true, combatState: true },
      });
      const combatState = readCombatState(campaign?.combatState);
      if (combatState.active && (
        campaign?.gameSystem !== 'DND_5E' ||
        combatState.mapId !== mapId ||
        combatState.currentTokenId !== tokenId
      )) {
        return;
      }
      if (movingToken.layer === 'spirit' && socket.role !== 'DM' && socket.userId &&
          !(await getSpiritVisibility(socket.campaignId, socket.userId))) {
        return;
      }

      const frameTokens = storedTokens.map((t) => (t.id === tokenId ? { ...t, position: { x, y } } : t));
      const recipients = await emitToTokenViewers(
        io,
        socket,
        ctx.map,
        frameTokens,
        tokenId,
        'token.move.preview',
        { tokenId, mapId, x, y, position: { x, y }, movedBy: socket.userId, preview: true },
        { excludeSender: true, viewers: ctx.viewers }
      );
      for (const recipientId of recipients) previewedSocketIds.add(recipientId);
      lastFrame = data;
    } catch (error) {
      logger.error('token.move failed', { err: error });
    }
  }

  /** Process queued frames one at a time, in arrival order (a stale waiting frame was overwritten). */
  async function drainFrames(): Promise<void> {
    try {
      while (pendingFrame) {
        const frame = pendingFrame;
        pendingFrame = null;
        await processFrame(frame);
      }
    } finally {
      frameInFlight = null;
    }
  }

  function enqueueFrame(data: FrameData): void {
    pendingFrame = data; // A frame still waiting is stale now: replace it.
    if (!frameInFlight) frameInFlight = drainFrames();
  }

  /**
   * TOKEN.MOVE - Position updates during drag (throttled to 60/s)
   * Validates coordinates and broadcasts to campaign
   */
  const handleTokenMove = throttle(enqueueFrame, 16); // 16ms = ~60fps (1000ms / 60fps = 16.67ms)

  socket.on('token.move', (data: FrameData) => {
    handleTokenMove(data);
  });

  /**
   * TOKEN.MOVE.END - User finishes dragging (final position)
   * Updates database and broadcasts to campaign
   */
  socket.on('token.move.end', async (rawData: MoveRequest) => {
    const suppliedRequestId = rawData?.requestId;
    let requestId = typeof suppliedRequestId === 'string' && suppliedRequestId.trim()
      ? suppliedRequestId.trim()
      : randomUUID(); // Temporary compatibility for clients predating request IDs.
    let tokenId = typeof rawData?.tokenId === 'string' ? rawData.tokenId : '';
    let mapId = typeof rawData?.mapId === 'string' ? rawData.mapId : '';
    const rejectEarly = (code: string, message: string) => emitMoveRejection(io, socket, previewedSocketIds, {
      requestId,
      tokenId,
      mapId,
      position: null,
      movement: null,
      error: { code, message },
    });
    try {
      if (!socket.campaignId) {
        rejectEarly('NOT_AUTHENTICATED', 'Not authenticated to a campaign.');
        return;
      }

      // No drag frame may follow the final position: drop pending ones and
      // let the one being processed finish first.
      handleTokenMove.cancel();
      pendingFrame = null;
      if (frameInFlight) await frameInFlight;
      drag = null;
      lastFrame = null;

      if (!isRecord(rawData)) {
        rejectEarly('INVALID_REQUEST', 'Invalid token move data.');
        return;
      }
      const data = rawData as MoveRequest;
      tokenId = typeof data?.tokenId === 'string' ? data.tokenId : '';
      mapId = typeof data?.mapId === 'string' ? data.mapId : '';
      const { x, y } = data ?? {};
      if (!tokenId || !mapId || typeof x !== 'number' || !Number.isInteger(x) ||
          typeof y !== 'number' || !Number.isInteger(y)) {
        rejectEarly('INVALID_DESTINATION', 'Token destination must use integer grid coordinates.');
        return;
      }
      if (data.requestId !== undefined && (typeof data.requestId !== 'string' || !data.requestId.trim() || requestId.length > 200)) {
        rejectEarly('INVALID_REQUEST_ID', 'requestId must be a non-empty string of at most 200 characters.');
        return;
      }
      if (data.route !== undefined && (!Array.isArray(data.route) || !data.route.every(validGridPoint))) {
        rejectEarly('INVALID_ROUTE', 'route must be an array of integer grid positions.');
        return;
      }

      // Finalize events are low-volume; refusing one silently would leave the
      // sender's locally dragged token out of sync with the persisted map.
      if (!tokenMoveLimiter.check(socket.id, 150, 1000)) {
        rejectEarly('RATE_LIMITED', 'Too many token movement requests.');
        return;
      }

      const route = data.route as GridPoint[] | undefined;
      const hasOverride = data.override !== undefined;
      const overrideReason = hasOverride && isRecord(data.override) && typeof data.override.reason === 'string'
        ? data.override.reason.trim()
        : '';

      const result = await withCampaignMapRowLock(prisma, socket.campaignId, mapId, async (tx, campaign, map) => {
        const tokensArray = (Array.isArray(map.tokens) ? map.tokens : []) as unknown as Token[];
        const tokenIndex = tokensArray.findIndex((token) => token.id === tokenId);
        if (tokenIndex < 0) return { ok: false, message: 'Token not found', code: 'TOKEN_NOT_FOUND' } as const;
        const token = tokensArray[tokenIndex]!;
        const position = validGridPoint(token.position) ? { x: token.position.x, y: token.position.y } : null;
        const state = readCombatState(campaign.combatState);
        const movementNow = state.movement?.tokenId === tokenId ? movementWireFromLedger(state.movement) : null;
        const reject = (code: string, message: string): MoveTransactionResult => ({
          ok: false,
          rejected: {
            requestId,
            tokenId,
            mapId,
            position,
            movement: code === 'UNRESOLVED_SPEED' && movementNow
              ? { ...movementNow, speedFeet: null, remainingMovementFeet: null }
              : movementNow,
            error: { code, message },
          },
        });

        if (!socket.userId) return reject('NOT_AUTHENTICATED', 'Not authenticated to a campaign.');
        const membership = await tx.campaignMembership.findUnique({
          where: { userId_campaignId: { userId: socket.userId, campaignId: campaign.id } },
          select: { role: true },
        });
        if (!membership) return reject('PERMISSION_DENIED', 'You are not a member of this campaign.');
        const role = membership.role;
        if (role === 'SPECTATOR') return reject('PERMISSION_DENIED', 'Spectators cannot move tokens.');
        if (role !== 'DM' && token.controlledBy !== socket.userId) {
          return reject('PERMISSION_DENIED', 'You do not have permission to move this token.');

        }
        if (token.layer === 'spirit' && role !== 'DM' && !(await getSpiritVisibility(campaign.id, socket.userId))) {
          return reject('PERMISSION_DENIED', 'You cannot interact with spirit layer tokens.');
        }

        if (!state.active) {
          if (hasOverride) return reject('OVERRIDE_NOT_SUPPORTED', 'Movement overrides are only available during D&D 5e combat.');
          const size = token.size;
          if (!validGridPoint(token.position) || !isRecord(size) ||
              !Number.isInteger(size.width) || Number(size.width) < 1 ||
              !Number.isInteger(size.height) || Number(size.height) < 1) {
            return reject('INVALID_TOKEN_GEOMETRY', 'Token position or footprint is invalid.');
          }
          if (x < 0 || y < 0 || x + Number(size.width) > map.width || y + Number(size.height) > map.height) {
            return reject('OUT_OF_BOUNDS', `Token footprint must remain within map bounds (0-${map.width - 1}, 0-${map.height - 1}).`);
          }
          const movedToken = { ...token, position: { x, y } };
          const updatedTokens = [...tokensArray];
          updatedTokens[tokenIndex] = movedToken;
          await tx.map.update({ where: { id: map.id }, data: { tokens: updatedTokens as any } });
          return {
            ok: true,
            activeCombat: false,
            map: withLightPolygons(map),
            previousTokens: tokensArray,
            updatedTokens,
            token: movedToken,
            movement: null,
            position: { x, y },
          } as const;
        }

        if (campaign.gameSystem !== 'DND_5E') {
          return reject('UNSUPPORTED_COMBAT_SYSTEM', 'Server-authoritative movement is only available for D&D 5e combat.');
        }
        if (state.mapId !== mapId) {
          return reject('TURN_MISMATCH', 'Active combat is on a different map.');
        }
        if (state.currentTokenId !== tokenId || !state.turnId || !state.combatId) {
          return reject('TURN_MISMATCH', 'Only the active combatant can move during its turn.');
        }
        if (hasOverride && (role !== 'DM' || !overrideReason || overrideReason.length > 500)) {
          return reject('OVERRIDE_REASON_REQUIRED', 'An explicit DM override requires a non-empty reason of at most 500 characters.');
        }
        if (!validGridPoint(token.position)) {
          return reject('INVALID_TOKEN_GEOMETRY', 'The token has an invalid current grid position.');
        }
        const ledger = state.movement;
        if (!ledger || ledger.turnId !== state.turnId || ledger.tokenId !== tokenId) {
          return reject('INVALID_MOVEMENT_LEDGER', 'The active turn has no valid movement ledger.');
        }

        let actor: MovementSpeedActor;
        if (token.characterId) {
          const lockedCharacter = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Character"
            WHERE "id" = ${token.characterId} AND "campaignId" = ${campaign.id}
            FOR UPDATE
          `;
          const character = lockedCharacter.length > 0
            ? await tx.character.findFirst({
              where: { id: token.characterId, campaignId: campaign.id },
              select: { gameSystem: true, data: true },
            })
            : null;
          if (!character) return reject('UNRESOLVED_SPEED', 'The token’s linked character could not be found in this campaign.');
          if (character.gameSystem !== 'DND_5E') {
            return reject('UNRESOLVED_SPEED', 'The token’s linked character is not using D&D 5e rules.');
          }
          actor = { kind: 'pc', characterData: character.data };
        } else {
          let templateStatBlock: unknown;
          if ((token as any).creatureTemplateId) {
            const template = await tx.creatureTemplate.findUnique({
              where: { id: (token as any).creatureTemplateId },
              select: { statBlock: true },
            });
            templateStatBlock = template?.statBlock;
          }
          actor = {
            kind: 'npc',
            statBlock: token.statBlock ?? templateStatBlock,
            conditions: token.conditions,
            metadata: token.metadata,
          };
        }

        const movementTokens = tokensArray as unknown as MovementToken[];
        const movementMap = {
          width: map.width,
          height: map.height,
          gridSize: map.gridSize,
          feetPerSquare: map.feetPerSquare,
          diagonalRule: map.diagonalRule,
          wallSegments: map.wallSegments,
          difficultTerrain: map.difficultTerrain,
          tokens: movementTokens,
        };
        const plannerInput = {
          tokenId,
          actor,
          destination: { x, y },
          route,
          map: movementMap as any,
          ledger: {
            tokenId: ledger.tokenId,
            turnId: ledger.turnId,
            spentFeet: ledger.spentFeet,
            dashBonusFeet: ledger.dashBonusFeet,
            diagonalStepsTaken: ledger.diagonalStepsTaken,
          },
          activeTurn: { tokenId: state.currentTokenId, turnId: state.turnId },
        };
        let plan = planCombatMovement(plannerInput);
        if (!plan.ok && plan.error.code === 'INSUFFICIENT_MOVEMENT' && hasOverride) {
          const overridden = planCombatMovement({
            ...plannerInput,
            ledger: { ...plannerInput.ledger, dashBonusFeet: Number.MAX_SAFE_INTEGER },
          });
          if (overridden.ok) {
            plan = {
              ...overridden,
              dashBonusFeet: ledger.dashBonusFeet,
              remainingMovementFeet: Math.max(0, overridden.speedFeet + ledger.dashBonusFeet - overridden.movementSpentFeet),
            };
          } else {
            plan = overridden;
          }
        }
        if (!plan.ok) return reject(plan.error.code, plan.error.message);

        const movedToken = { ...token, position: plan.destination };
        const updatedTokens = [...tokensArray];
        updatedTokens[tokenIndex] = movedToken;
        state.movement = {
          ...ledger,
          speedFeet: plan.speedFeet,
          spentFeet: plan.movementSpentFeet,
          dashBonusFeet: ledger.dashBonusFeet,
          dashUsed: ledger.dashUsed,
          diagonalStepsTaken: plan.diagonalStepsTaken,
          remainingMovementFeet: plan.remainingMovementFeet,
        };

        await tx.map.update({ where: { id: map.id }, data: { tokens: updatedTokens as any } });
        await saveCampaignCombatState(tx, campaign.id, state);
        if (hasOverride) {
          const ordinaryRemainingBeforeFeet = plan.speedFeet + ledger.dashBonusFeet - ledger.spentFeet;
          const ordinaryRemainingAfterFeet = plan.speedFeet + ledger.dashBonusFeet - plan.movementSpentFeet;
          await tx.message.create({
            data: {
              campaignId: campaign.id,
              userId: socket.userId,
              type: 'SYSTEM',
              content: `DM movement override: ${token.name} moved (${requestId})`,
              metadata: {
                kind: 'combat_movement_override',
                reason: overrideReason,
                combatId: state.combatId,
                turnId: state.turnId,
                tokenId,
                from: plan.start,
                to: plan.destination,
                ordinaryCostFeet: plan.movementCostFeet,
                ordinaryRemainingFeet: Math.max(0, ordinaryRemainingAfterFeet),
                ordinaryRemainingBeforeFeet,
                ordinaryRemainingAfterFeet,
                requestId,
              } as any,
            },
          });
        }

        const movement: MovementWire = {
          tokenId,
          turnId: state.turnId,
          speedFeet: plan.speedFeet,
          movementCostFeet: plan.movementCostFeet,
          spentFeet: plan.movementSpentFeet,
          remainingMovementFeet: plan.remainingMovementFeet,
          dashBonusFeet: ledger.dashBonusFeet,
          dashUsed: ledger.dashUsed,
          diagonalStepsTaken: plan.diagonalStepsTaken,
          route: plan.route,
          override: hasOverride,
        };
        return {
          ok: true,
          activeCombat: true,
          map: withLightPolygons(map),
          previousTokens: tokensArray,
          updatedTokens,
          token: movedToken,
          movement,
          position: plan.destination,
        } as const;
      });

      if (!result.ok) {
        if ('rejected' in result) {
          emitMoveRejection(io, socket, previewedSocketIds, result.rejected);
        } else {
          rejectEarly(result.code ?? 'MOVE_REJECTED', result.message);
        }
        return;
      }

      bumpMapVersion(mapId); // invalidate cached drag snapshots after commit
      const movementBase: MoveWireBase = {
        requestId,
        tokenId,
        mapId,
        position: result.position,
        movement: result.movement,
      };
      socket.emit('token.move.accepted', movementBase);

      const movedPayload = {
        tokenId,
        mapId,
        x: result.position.x,
        y: result.position.y,
        position: result.position,
        movedBy: socket.userId,
        requestId,
        movement: result.movement,
      };

      let viewers: Promise<RoomViewer[]> | null = null;
      const roomViewers = () => (viewers ??= getRoomViewers(io, socket.campaignId!));
      if (!result.map.lightingEnabled) {
        await emitToTokenViewers(io, socket, result.map, result.updatedTokens, tokenId, 'token.moved', movedPayload, {
          excludeSender: false,
          viewers: roomViewers,
        });
      } else {
        const view = tokenViewCache(result.map);
        for (const { socket: recipient, viewer } of await roomViewers()) {
          if (viewer.role === 'DM') {
            recipient.emit('token.moved', movedPayload);
            continue;
          }
          const diff = diffTokenViews(view(result.previousTokens, viewer), view(result.updatedTokens, viewer), tokenId);
          if (diff.eventToken?.kind === 'removed') {
            recipient.emit('token:disappeared', { tokenId, mapId });
          } else if (diff.eventToken) {
            recipient.emit('token.moved', movedPayload);
            recipient.emit('token:appeared', { token: diff.eventToken.token, mapId });
          }
          for (const visibleToken of diff.added) recipient.emit('token:appeared', { token: visibleToken, mapId });
          for (const removedId of diff.removedIds) recipient.emit('token:disappeared', { tokenId: removedId, mapId });
        }
      }

      if (result.activeCombat) {
        const persistedState = await loadCampaignCombatState(prisma, socket.campaignId);
        io.to(socket.campaignId).emit('initiative.state', persistedState);
      }
      previewedSocketIds.clear();
      logger.debug('token.move.end', { tokenId, x: result.position.x, y: result.position.y, userId: socket.userId });
    } catch (error) {
      logger.error('token.move.end failed', { err: error });
      rejectEarly('MOVE_FAILED', 'Failed to finalize token movement.');
    }
  });
}
