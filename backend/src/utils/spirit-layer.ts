import { prisma } from '../config/database';
import { computeVisibility, isPointVisible, type VisibilityPolygon } from './serverRaycasting';
import type { WallSegment, LightSource } from '../types/walls';
import logger from './logger';

/**
 * Spirit Layer Utility Functions
 * Spirit Layer Implementation
 *
 * All spirit layer filtering happens server-side.
 * Spirit layer tokens and data are never sent to players — only DMs see them.
 */

// Token interface
interface Token {
  id: string;
  characterId?: string | null;
  name: string;
  imageUrl: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  layer: 'token' | 'spirit';
  visible: boolean;
  controlledBy?: string | null;
  rotation: number;
  conditions: string[];
  metadata: Record<string, any>;
  type?: string;
  disposition?: string | null;
  hp?: { current: number; max: number; temp: number } | null;
  showHpBar?: boolean;
  notes?: string;
  initiative?: number | null;
  sightRadius?: number;
  displayMode?: 'pog' | 'top-down' | 'full-art';
  statBlock?: Record<string, any> | null;
  creatureTemplateId?: string | null;
}

// Map data as returned from Prisma
interface MapData {
  id: string;
  campaignId: string;
  name: string;
  imageUrl: string;
  width: number;
  height: number;
  gridSize: number;
  feetPerSquare: number;
  diagonalRule: string;
  baseLayerUrl: string;
  spiritLayerUrl: string | null;
  tokens: unknown;
  annotations: unknown;
  wallSegments: unknown;
  fogData: unknown;
  lightingEnabled: boolean;
  lights: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Check if a user can see the spirit layer for a given campaign.
 *
 * Visibility rules:
 * - DM always sees the spirit layer
 * - Players see it when the DM has globally enabled it (campaign.spiritLayerEnabled), OR
 *   when the player's own token (identified by controlledBy) is currently on the spirit
 *   layer in the campaign's current map — i.e. they have personally crossed over.
 * - Spectators follow the same rules as players
 *
 * @param campaignId - The campaign ID
 * @param userId - The user ID to check visibility for
 * @returns Whether the user can see spirit layer content
 */
export async function getSpiritVisibility(
  campaignId: string,
  userId: string
): Promise<boolean> {
  // Get the user's membership and the campaign's spirit layer setting + current map
  const [membership, campaign] = await Promise.all([
    prisma.campaignMembership.findUnique({
      where: {
        userId_campaignId: { userId, campaignId },
      },
      select: { role: true },
    }),
    prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { spiritLayerEnabled: true, currentMapId: true },
    }),
  ]);

  if (!membership || !campaign) {
    return false;
  }

  // DM always sees the spirit layer
  if (membership.role === 'DM') {
    return true;
  }

  // All players/spectators see it when DM has globally enabled it
  if (campaign.spiritLayerEnabled) {
    return true;
  }

  // Individual player check: are they personally in the spirit realm?
  // A player has crossed over if their token (controlledBy === userId) is on
  // the spirit layer and visible in the campaign's current map.
  if (campaign.currentMapId) {
    const currentMap = await prisma.map.findUnique({
      where: { id: campaign.currentMapId },
      select: { tokens: true },
    });

    if (currentMap?.tokens) {
      const tokens = (Array.isArray(currentMap.tokens) ? currentMap.tokens : []) as unknown as Token[];
      const isPersonallyInSpiritRealm = tokens.some(
        (t) => t.layer === 'spirit' && t.visible && t.controlledBy === userId
      );
      if (isPersonallyInSpiritRealm) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Batch variant of {@link getSpiritVisibility} for fan-out broadcasts.
 *
 * The per-socket loops in the token/spirit/map handlers previously called
 * getSpiritVisibility() once per connected socket — each doing 2–3 DB round
 * trips — turning an O(players) event into an O(players) burst of queries.
 * This computes the same visibility for every requested user in a fixed
 * number of queries (membership roles in one query, campaign once, current-map
 * tokens at most once), then resolves each user in memory. The result is
 * behaviourally identical to calling getSpiritVisibility() per user.
 *
 * @param campaignId - The campaign ID
 * @param userIds - The user IDs to resolve (duplicates are de-duped)
 * @returns Map of userId → whether that user can see the spirit layer
 */
export async function getSpiritVisibilityBatch(
  campaignId: string,
  userIds: string[]
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) return result;

  const [memberships, campaign] = await Promise.all([
    prisma.campaignMembership.findMany({
      where: { campaignId, userId: { in: uniqueIds } },
      select: { userId: true, role: true },
    }),
    prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { spiritLayerEnabled: true, currentMapId: true },
    }),
  ]);

  const roleByUser = new Map(memberships.map((m) => [m.userId, m.role]));

  // The current-map crossover check is only needed when the spirit layer is
  // globally off AND at least one requested user is a non-DM member. Fetch the
  // current map's spirit tokens at most once (not once per user).
  let spiritTokens: Token[] | null = null;
  const needsCrossover =
    campaign != null &&
    !campaign.spiritLayerEnabled &&
    campaign.currentMapId != null &&
    uniqueIds.some((id) => {
      const role = roleByUser.get(id);
      return role != null && role !== 'DM';
    });

  if (needsCrossover && campaign?.currentMapId) {
    const currentMap = await prisma.map.findUnique({
      where: { id: campaign.currentMapId },
      select: { tokens: true },
    });
    const tokens = (Array.isArray(currentMap?.tokens) ? currentMap!.tokens : []) as unknown as Token[];
    spiritTokens = tokens.filter((t) => t.layer === 'spirit' && t.visible);
  }

  for (const userId of uniqueIds) {
    const role = roleByUser.get(userId);
    if (!role || !campaign) {
      result.set(userId, false);
      continue;
    }
    if (role === 'DM' || campaign.spiritLayerEnabled) {
      result.set(userId, true);
      continue;
    }
    result.set(userId, spiritTokens != null && spiritTokens.some((t) => t.controlledBy === userId));
  }

  return result;
}

/**
 * Filter tokens based on user role and spirit layer visibility.
 *
 * 
 * - DM always sees all tokens on both layers
 * - Players/spectators only see spirit layer tokens when spirit visibility is enabled
 * - Hidden tokens (visible: false) are only visible to the DM
 *
 * @param tokens - Raw token array from the map
 * @param userRole - The user's campaign role (DM, PLAYER, SPECTATOR)
 * @param spiritVisible - Whether the spirit layer is visible to this user
 * @returns Filtered token array
 */
export function filterTokensByRole(
  tokens: unknown,
  userRole: string,
  spiritVisible: boolean
): Token[] {
  const tokensArray = (Array.isArray(tokens) ? tokens : []) as Token[];

  // DM sees everything (including notes)
  if (userRole === 'DM') {
    return tokensArray;
  }

  const visibleTokens = tokensArray.filter((token) => {
    // Players only see tokens on their currently active layer:
    // - Spirit layer visible (player is in spirit realm): only spirit tokens
    // - Spirit layer hidden (player is on material plane): only material tokens
    if (spiritVisible && token.layer !== 'spirit') return false;
    if (!spiritVisible && token.layer !== 'token') return false;

    // Filter out hidden tokens (only DM can see invisible tokens)
    if (!token.visible) {
      return false;
    }

    return true;
  });

  // Strip DM-only notes field from non-DM clients
  return visibleTokens.map((token) => {
    const { notes: _notes, ...rest } = token;
    return rest as Token;
  });
}

/**
 * Whether `token` is the viewer's own: controlled by them (`controlledBy`),
 * or linked (`characterId`) to a character they own or are assigned through
 * their campaign membership `characterIds` (pass both as `ownCharacterIds`).
 *
 * The one ownership rule for dynamic lighting on the server: own tokens are
 * always visible to the viewer and are their vision sources. The client's
 * darkness rendering (MapCanvas isOwnToken) uses the same rule.
 */
export function isOwnToken(
  token: { controlledBy?: string | null; characterId?: string | null },
  userId: string,
  ownCharacterIds?: ReadonlySet<string>
): boolean {
  if (token.controlledBy === userId) return true;
  return !!(token.characterId && ownCharacterIds?.has(token.characterId));
}

/**
 * Visibility polygons of a map's enabled light sources (dim radius). They do
 * not depend on the viewer, so a broadcast computes them once and passes them
 * to every viewer's filterTokensByLighting call.
 */
export function computeLightPolygons(
  walls: unknown,
  mapWidth: number,
  mapHeight: number,
  gridSize: number,
  lights: unknown
): VisibilityPolygon[] {
  const wallSegs = (Array.isArray(walls) ? walls : []) as unknown as WallSegment[];
  const lightSources = (Array.isArray(lights) ? lights : []) as unknown as LightSource[];
  const mapWidthPx = mapWidth * gridSize;
  const mapHeightPx = mapHeight * gridSize;
  // Uses dimRadius (outer edge) — anything within dim range is "visible" for token filtering.
  // Light positions are already in map-space pixels (Y=0 at top), no flip needed.
  return lightSources
    .filter((l) => l.enabled)
    .map((light) => {
      const dimRadiusPx = (light.dimRadius ?? light.brightRadius ?? 3) * gridSize;
      return computeVisibility({ x: light.x, y: light.y }, wallSegs, mapWidthPx, mapHeightPx, dimRadiusPx);
    });
}

/** Options of filterTokensByLighting. */
export interface LightingFilterOptions {
  /** Character ids the viewer owns or is assigned (see isOwnToken). */
  ownCharacterIds?: ReadonlySet<string>;
  /** Precomputed computeLightPolygons() for this map (skips recomputing them). */
  lightPolygons?: VisibilityPolygon[];
}

/**
 * Filter tokens by dynamic lighting visibility for a non-DM player.
 *
 * When lightingEnabled is true on a map, players should only
 * receive tokens that are within their character's line of sight.
 * A viewer's own tokens (isOwnToken) are always kept and are the vision
 * sources, together with the map's enabled lights. A viewer with no vision
 * source gets only their own tokens.
 *
 * @param tokens         Tokens already filtered by role/spirit rules
 * @param playerUserId   The player's user ID
 * @param walls          Map wall segments (for raycasting)
 * @param mapWidth       Map pixel width
 * @param mapHeight      Map pixel height
 * @param gridSize       Map grid size in pixels (to convert position to map-space)
 * @param lightingEnabled Whether dynamic lighting is active
 * @param lights         Map light sources
 * @param options        Own character ids, precomputed light polygons
 * @returns Tokens visible to this player
 */
export function filterTokensByLighting(
  tokens: Token[],
  playerUserId: string,
  walls: unknown,
  mapWidth: number,
  mapHeight: number,
  gridSize: number,
  lightingEnabled: boolean,
  lights?: unknown,
  options: LightingFilterOptions = {}
): Token[] {
  if (!lightingEnabled) return tokens;

  const isOwn = (t: Token) => isOwnToken(t, playerUserId, options.ownCharacterIds);
  const wallSegs = (Array.isArray(walls) ? walls : []) as unknown as WallSegment[];

  // Find all tokens owned by this player — their vision sources
  const myTokens = tokens.filter(isOwn);

  const startMs = Date.now();
  const mapWidthPx = mapWidth * gridSize;
  const mapHeightPx = mapHeight * gridSize;

  // Compute combined visibility polygons from all controlled tokens.
  // Token grid coords use Y=0 at bottom (VTT standard); wall pixel coords use Y=0 at top.
  // Apply the Y-flip so both are in the same canvas pixel coordinate space.
  const visPolygons = myTokens.map((t) => {
    const cx = (t.position.x + (t.size?.width ?? 1) / 2) * gridSize;
    const cy = (mapHeight - 1 - t.position.y + (t.size?.height ?? 1) / 2) * gridSize;
    const radiusPx = (t.sightRadius ?? 0) * gridSize;
    return computeVisibility({ x: cx, y: cy }, wallSegs, mapWidthPx, mapHeightPx, radiusPx);
  });

  // Additive visibility: also the visibility polygons of each enabled light source.
  const lightPolygons = options.lightPolygons ?? computeLightPolygons(walls, mapWidth, mapHeight, gridSize, lights);
  visPolygons.push(...lightPolygons);

  const elapsed = Date.now() - startMs;
  if (elapsed > 50) {
    logger.warn(`[lighting] filterTokensByLighting took ${elapsed}ms for userId=${playerUserId} (${myTokens.length} tokens, ${lightPolygons.length} lights)`);
  }

  // Keep own tokens and tokens inside any of the visibility polygons (token or light).
  // No vision source at all → only own tokens (none).
  return tokens.filter((t) => {
    if (isOwn(t)) return true;
    if (visPolygons.length === 0) return false;

    const cx = (t.position.x + (t.size?.width ?? 1) / 2) * gridSize;
    const cy = (mapHeight - 1 - t.position.y + (t.size?.height ?? 1) / 2) * gridSize;
    return visPolygons.some((poly) => isPointVisible({ x: cx, y: cy }, poly));
  });
}

/** The map fields the per-viewer token filter reads. */
export type TokenViewMap = Pick<
  MapData,
  'lightingEnabled' | 'wallSegments' | 'lights' | 'width' | 'height' | 'gridSize'
> & {
  /** Precomputed light polygons (withLightPolygons) shared by every viewer of one broadcast. */
  lightPolygons?: VisibilityPolygon[];
};

/**
 * The map with its light polygons computed once (only when lighting is on),
 * for a broadcast that filters the same map for many viewers.
 */
export function withLightPolygons<T extends TokenViewMap>(map: T): T {
  if (!map.lightingEnabled || map.lightPolygons) return map;
  return {
    ...map,
    lightPolygons: computeLightPolygons(map.wallSegments, map.width, map.height, map.gridSize, map.lights),
  };
}

/** Who is looking at a map: the inputs of one viewer's token view. */
export interface TokenViewer {
  role: string;
  spiritVisible: boolean;
  userId?: string;
  /** Character ids the viewer owns or is assigned (isOwnToken). */
  characterIds?: ReadonlySet<string>;
}

/**
 * The tokens one viewer may receive from a map: filterTokensByRole, then —
 * for a non-DM viewer on a map with dynamic lighting — filterTokensByLighting
 * from that viewer's line of sight (own tokens per isOwnToken). A non-DM
 * viewer without a userId gets nothing (fails closed).
 *
 * The single token pipeline shared by filterMapData (map GET, map.changed),
 * the REST token-event broadcast (broadcastTokenEvent), the map view-change
 * broadcast (broadcastMapViewChange) and the token movement socket handlers.
 */
export function filterTokensForViewer(tokens: unknown, map: TokenViewMap, viewer: TokenViewer): Token[] {
  if (viewer.role === 'DM') return filterTokensByRole(tokens, 'DM', true);
  if (!viewer.userId) return [];
  const roleFiltered = filterTokensByRole(tokens, viewer.role, viewer.spiritVisible);
  if (!map.lightingEnabled) return roleFiltered;
  return filterTokensByLighting(
    roleFiltered,
    viewer.userId,
    map.wallSegments,
    map.width,
    map.height,
    map.gridSize,
    true,
    map.lights,
    { ownCharacterIds: viewer.characterIds, lightPolygons: map.lightPolygons }
  );
}

/**
 * Character ids each user owns in the campaign or is assigned through their
 * campaign membership `characterIds` — the `characterIds` of TokenViewer.
 */
export async function getOwnCharacterIdsBatch(
  campaignId: string,
  userIds: string[]
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) return result;
  for (const id of uniqueIds) result.set(id, new Set());

  const [memberships, characters] = await Promise.all([
    prisma.campaignMembership.findMany({
      where: { campaignId, userId: { in: uniqueIds } },
      select: { userId: true, characterIds: true },
    }),
    prisma.character.findMany({
      where: { campaignId, userId: { in: uniqueIds } },
      select: { id: true, userId: true },
    }),
  ]);
  for (const m of memberships ?? []) {
    for (const id of m.characterIds ?? []) result.get(m.userId)?.add(id);
  }
  for (const c of characters ?? []) result.get(c.userId)?.add(c.id);
  return result;
}

/**
 * Resolve TokenViewer inputs (spirit visibility, own characters) for the
 * given sockets' users in one batch. DMs need neither.
 */
export async function getTokenViewersFor<S extends { role?: string; userId?: string }>(
  campaignId: string,
  sockets: S[]
): Promise<Array<{ socket: S; viewer: TokenViewer }>> {
  const playerIds = sockets
    .filter((s) => s.role !== 'DM' && s.userId)
    .map((s) => s.userId as string);
  const [visibility, characterIds] = playerIds.length
    ? await Promise.all([getSpiritVisibilityBatch(campaignId, playerIds), getOwnCharacterIdsBatch(campaignId, playerIds)])
    : [new Map<string, boolean>(), new Map<string, Set<string>>()];
  return sockets.map((socket) => ({
    socket,
    viewer:
      socket.role === 'DM'
        ? { role: 'DM', spiritVisible: true, userId: socket.userId }
        : {
            role: socket.role ?? 'SPECTATOR',
            spiritVisible: !!(socket.userId && visibility.get(socket.userId)),
            userId: socket.userId,
            characterIds: socket.userId ? characterIds.get(socket.userId) : undefined,
          },
  }));
}

/** Cache key of a viewer's token view (a user's sockets share one computation). */
export function tokenViewerKey(viewer: TokenViewer): string {
  return `${viewer.role}|${viewer.spiritVisible}|${viewer.userId ?? ''}`;
}

/** How one viewer's token view changed between two filtered views. */
export interface TokenViewDiff<T extends { id: string }> {
  /** The event's own token: its new view (`added` / `updated`), `removed`, or null (never seen). */
  eventToken: { kind: 'added' | 'updated'; token: T } | { kind: 'removed' } | null;
  /** Other tokens that entered the view. */
  added: T[];
  /** Ids of other tokens that left the view. */
  removedIds: string[];
}

/**
 * Compare a viewer's filtered token view before and after a change to one
 * token (`tokenId`; null when no token changed, e.g. a wall or light did).
 * Other tokens can enter or leave the view too — e.g. when the changed token
 * is the viewer's own and their line of sight moved.
 */
export function diffTokenViews<T extends { id: string }>(
  before: T[],
  after: T[],
  tokenId: string | null
): TokenViewDiff<T> {
  const beforeIds = new Set(before.map((t) => t.id));
  const afterIds = new Set(after.map((t) => t.id));
  const eventAfter = tokenId === null ? undefined : after.find((t) => t.id === tokenId);
  const seenBefore = tokenId !== null && beforeIds.has(tokenId);
  const eventToken: TokenViewDiff<T>['eventToken'] = eventAfter
    ? { kind: seenBefore ? 'updated' : 'added', token: eventAfter }
    : seenBefore
      ? { kind: 'removed' }
      : null;
  return {
    eventToken,
    added: after.filter((t) => t.id !== tokenId && !beforeIds.has(t.id)),
    removedIds: before.filter((t) => t.id !== tokenId && !afterIds.has(t.id)).map((t) => t.id),
  };
}

/**
 * Filter entire map data based on user role and spirit layer visibility.
 *
 * This filters:
 * - Tokens (via filterTokensByRole)
 * - Spirit layer URL (hidden from non-DMs when spirit layer is not visible)
 *
 * 
 * - CRITICAL: Never send spirit layer data to non-privileged users
 *
 * @param mapData - Raw map data from Prisma
 * @param userRole - The user's campaign role
 * @param spiritVisible - Whether the spirit layer is visible to this user
 * @returns Filtered map data safe to send to the client
 */
export function filterMapData(
  mapData: MapData,
  userRole: string,
  spiritVisible: boolean,
  userId?: string,
  characterIds?: ReadonlySet<string>
): MapData & { tokens: Token[] } {
  const filteredTokens = filterTokensForViewer(mapData.tokens, mapData, {
    role: userRole,
    spiritVisible,
    userId,
    characterIds,
  });

  return {
    ...mapData,
    tokens: filteredTokens,
    // Remove spirit layer URL if user shouldn't see it
    spiritLayerUrl: (userRole === 'DM' || spiritVisible) ? mapData.spiritLayerUrl : null,
    // Wall segments are sent to all roles (players need them for visibility rendering)
    wallSegments: mapData.wallSegments ?? [],
    // Light sources are sent to all roles (players need them for visibility rendering)
    lights: mapData.lights ?? [],
    // Fog data is DM-only (full state); players receive derived revealed-cells via WebSocket
    fogData: userRole === 'DM' ? mapData.fogData : null,
    lightingEnabled: mapData.lightingEnabled,
  };
}
