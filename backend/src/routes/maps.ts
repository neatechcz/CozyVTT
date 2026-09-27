import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { AuthenticatedRequest } from '../middleware/rbac';
import { campaignMember, campaignDM } from '../middleware/compose';
import { prisma } from '../config/database';
import { filterMapData, getOwnCharacterIdsBatch, getSpiritVisibility, getTokenViewersFor } from '../utils/spirit-layer';
import { broadcastMapViewChange, broadcastToCampaign, broadcastTokenEvent, getSocketInstance } from '../websocket/utils';
import { normalizeAssetUrl, extractAssetId } from '../utils/asset-urls';
import { canReadAssetById } from '../services/permissions';

import { WallSegmentSchema, WallSegmentsArraySchema, FogOperationSchema, LightSourceSchema, LightSourcesArraySchema, LightSourceUpdateSchema } from '../validators/walls';
import { validateTokenShapes, TokenMetadataSchema } from '../validators/tokens';
import type { WallSegment, FogState, LightSource } from '../types/walls';
import { parseUVTT } from '../services/uvttParser';
import { buildUVTT } from '../services/uvttExporter';
import { fileTypeFromBuffer } from 'file-type';
import {
  getFilePath,
  ensureDirectory,
  isAllowedMimeType,
  getFileSizeLimit,
  ALLOWED_EXTENSIONS,
} from '../utils/fileUtils';
import { generateThumbnail } from '../utils/thumbnails';
import { uploadLimiter } from './assets';
import { CampaignRowNotFoundError, MapRowNotFoundError, withCampaignMapRowLock } from '../services/combatStatePersistence';
import { readCombatState } from '../websocket/initiativeState';
import type { AuthenticatedSocket } from '../websocket/auth';
import { bumpMapVersion } from '../websocket/mapVersion';

import sharp from 'sharp';
import logger from '../utils/logger';
import { toJson } from '../utils/prisma-json';
import type { Prisma } from '@prisma/client';
import type { Token } from '../websocket/shared';

/** Multer configured for UVTT file uploads (memory storage — files are small JSON). */
const uvttUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB — UVTT files can be large (embedded image)
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.uvtt', '.dd2vtt', '.df2vtt'].includes(ext) || file.mimetype === 'application/json') {
      cb(null, true);
    } else {
      cb(new Error('Only .uvtt, .dd2vtt, and .df2vtt files are supported'));
    }
  },
});

const router = Router({ mergeParams: true }); // Important: Merge params from parent router

// The token shape lives in websocket/shared.ts — see the note there on why this
// file no longer keeps its own copy.

const VALID_TOKEN_TYPES = ['player', 'npc', 'object'];
const VALID_TOKEN_DISPOSITIONS = ['friendly', 'neutral', 'hostile'];
const VALID_DISPLAY_MODES = ['pog', 'top-down', 'full-art'];

function isGridPosition(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  return typeof position.x === 'number' && Number.isSafeInteger(position.x) &&
    typeof position.y === 'number' && Number.isSafeInteger(position.y);
}

function isTokenSize(value: unknown): value is { width: number; height: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const size = value as Record<string, unknown>;
  return typeof size.width === 'number' && Number.isSafeInteger(size.width) &&
    typeof size.height === 'number' && Number.isSafeInteger(size.height) &&
    (size.width as number) > 0 && (size.height as number) > 0;
}

function footprintFitsMap(position: { x: number; y: number }, size: { width: number; height: number }, map: { width: number; height: number }): boolean {
  return position.x >= 0 && position.y >= 0 &&
    position.x + size.width <= map.width && position.y + size.height <= map.height;
}

/** Broadcast an updated full map through the same per-viewer filtering as map.change. */
async function broadcastMapSnapshot(campaignId: string, map: any): Promise<void> {
  const io = getSocketInstance();
  const sockets = await io.in(campaignId).fetchSockets();
  const viewers = await getTokenViewersFor(
    campaignId,
    sockets.map((socket) => socket as unknown as AuthenticatedSocket)
  );

  for (const { socket, viewer } of viewers) {
    const filteredMap = filterMapData(
      { ...map, tokens: map.tokens as any, annotations: map.annotations as any },
      viewer.role,
      viewer.spiritVisible,
      viewer.userId,
      viewer.characterIds
    );
    socket.emit('map.changed', { mapId: map.id, mapData: filteredMap, spiritVisible: viewer.spiritVisible });
  }
}

/**
 * Map CRUD Routes
 * Map Endpoints
 *
 * All routes are prefixed with /api/campaigns/:campaignId/maps
 */

/**
 * POST /api/campaigns/:campaignId/maps
 * Create a new map for the campaign
 * Requires: DM role
 */
router.post('/', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId } = req.params;
    const { name, imageUrl, width, height, gridSize, spiritLayerUrl, feetPerSquare, diagonalRule } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Map name is required',
      });
    }

    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Map imageUrl (asset ID) is required',
      });
    }

    if (!width || typeof width !== 'number' || width <= 0) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Map width must be a positive number',
      });
    }

    if (!height || typeof height !== 'number' || height <= 0) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Map height must be a positive number',
      });
    }

    // gridSize is optional, defaults to 50 in schema
    const mapGridSize = gridSize && typeof gridSize === 'number' && gridSize > 0 ? gridSize : 50;

    // feetPerSquare: positive integer, defaults to 5
    const mapFeetPerSquare = feetPerSquare && Number.isInteger(feetPerSquare) && feetPerSquare > 0 && feetPerSquare <= 100
      ? feetPerSquare : 5;

    // diagonalRule: must be "flat" or "alternating", defaults to "flat"
    const mapDiagonalRule = diagonalRule === 'flat' || diagonalRule === 'alternating' ? diagonalRule : 'flat';

    // Normalize asset URLs to full paths
    const normalizedImageUrl = normalizeAssetUrl(imageUrl, 'maps');
    const normalizedSpiritLayerUrl = spiritLayerUrl ? normalizeAssetUrl(spiritLayerUrl, 'maps') : null;

    // imageUrl is required, should never be null at this point
    if (!normalizedImageUrl) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid map imageUrl',
      });
    }

    // SECURITY: you may only point a map at a picture you can already see.
    //
    // Normalising a URL formats it; it does not check anything. Storing an
    // unchecked reference is what let someone read a stranger's private asset —
    // they created a campaign of their own, made a map naming the asset id, and
    // the read rule then saw a legitimate-looking reference and allowed it.
    // Refusing the reference is the half of that fix that stops it being
    // created in the first place.
    const referenced = [normalizedImageUrl, normalizedSpiritLayerUrl].filter(
      (url): url is string => typeof url === 'string' && url.length > 0
    );
    const isAdmin = req.session.platformRole === 'ADMIN';
    for (const url of referenced) {
      const assetId = extractAssetId(url);
      if (!assetId) continue;
      if (!(await canReadAssetById(assetId, req.session.userId!, isAdmin))) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You do not have access to that image',
        });
      }
    }

    // Create the map
    const map = await prisma.map.create({
      data: {
        campaignId,
        name: name.trim(),
        imageUrl: normalizedImageUrl, // Full path: /api/assets/maps/{uuid}
        baseLayerUrl: normalizedImageUrl, // Store same value in baseLayerUrl for now
        width,
        height,
        gridSize: mapGridSize,
        feetPerSquare: mapFeetPerSquare,
        diagonalRule: mapDiagonalRule,
        spiritLayerUrl: normalizedSpiritLayerUrl,
        tokens: [], // Initialize empty tokens array
        annotations: [], // Initialize empty annotations array
      },
    });

    return res.status(201).json({ map });
  } catch (error) {
    logger.error('Error creating map', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create map',
    });
  }
});

/**
 * GET /api/campaigns/:campaignId/maps
 * List all maps for the campaign
 * Requires: Campaign membership
 */
router.get('/', campaignMember, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId } = req.params;

    const maps = await prisma.map.findMany({
      where: { campaignId },
      select: {
        id: true,
        name: true,
        imageUrl: true, // Thumbnail reference
        width: true,
        height: true,
        gridSize: true,
        feetPerSquare: true,
        diagonalRule: true,
        lightingEnabled: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.status(200).json({ maps });
  } catch (error) {
    logger.error('Error fetching maps', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch maps',
    });
  }
});

/**
 * POST /api/campaigns/:campaignId/maps/import-uvtt
 * Import a Universal VTT (.uvtt / .dd2vtt) file.
 *
 * Creates a new map from the embedded image and wall data.
 * The UVTT format is exported by Dungeondraft, DunGen, Dungeon Alchemist, etc.
 * Requires: DM role
 */
router.post(
  '/import-uvtt',
  campaignDM,
  // Writes a file to disk exactly as an upload does, so it shares the ceiling.
  uploadLimiter,
  uvttUpload.single('file'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { campaignId } = req.params;
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      if (!req.file?.buffer) {
        return res.status(400).json({ error: 'Validation Error', message: 'No UVTT file uploaded' });
      }

      const mapName = (req.body.name as string)?.trim() || path.basename(req.file.originalname, path.extname(req.file.originalname));
      const gridSizePx = Number(req.body.gridSize) || 70;

      // ── Parse the UVTT file ──────────────────────────────────────────────
      const confirmed = req.body.confirm === 'true' || req.body.confirm === true;
      const includeObjectWalls =
        req.body.includeObjectWalls === 'true' || req.body.includeObjectWalls === true;

      let parsed;
      try {
        parsed = parseUVTT(req.file.buffer, gridSizePx, { includeObjectWalls });
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : 'Failed to parse UVTT file';
        return res.status(400).json({ error: 'Parse Error', message: msg });
      }

      // ── Anything for the DM to decide before this becomes a map ──────────
      // Two things can need an answer. Some exporters crop the picture to part
      // of the map and write out the geometry for all of it, which imports as
      // bare areas with walls that cannot even block sight, since sight stops
      // at the map's edges. And a file may carry walls for its furniture, which
      // block sight like any other but are the DM's call.
      //
      // Asked before anything is written, so declining leaves nothing behind.
      const { walls, doors, lights } = parsed.outOfBounds;
      const hasOutOfBounds = walls > 0 || doors > 0 || lights > 0;
      const offersObjectWalls = !includeObjectWalls && parsed.objectWallCount > 0;
      if (!confirmed && (hasOutOfBounds || offersObjectWalls)) {
        return res.status(409).json({
          error: 'Confirmation Required',
          // Clients branch on the code, never the wording.
          code: 'UVTT_IMPORT_NEEDS_CONFIRMATION',
          message: 'This file needs a decision before it can be imported.',
          outOfBounds: { walls, doors, lights },
          objectWalls: parsed.objectWallCount,
        });
      }

      // ── Refuse what the map editor could never save ──────────────────────
      // Import wrote these straight to the row while every later edit checks
      // them, so an oversized file used to import and then refuse the first
      // wall edit. Say it here, where it can still be acted on.
      const wallCheck = WallSegmentsArraySchema.safeParse(parsed.wallSegments);
      if (!wallCheck.success) {
        return res.status(400).json({
          error: 'Validation Error',
          message:
            `This file has ${parsed.wallSegments.length} wall segments, more than a map can hold. ` +
            (includeObjectWalls && parsed.objectWallCount > 0
              ? 'Importing without its furniture walls may bring it under the limit.'
              : 'Split it into smaller maps in the tool that made it.'),
        });
      }
      const lightCheck = LightSourcesArraySchema.safeParse(parsed.lightSources);
      if (!lightCheck.success) {
        return res.status(400).json({
          error: 'Validation Error',
          message: `This file's lights cannot be imported: ${lightCheck.error.issues[0]?.message ?? 'they are outside the limits a map allows'}.`,
        });
      }

      // ── Check the picture before it reaches disk ─────────────────────────
      // This route writes the image itself instead of going through the upload
      // middleware, so the checks every other upload gets have to be made here
      // or not at all. Read the bytes rather than trusting the file: a UVTT is
      // JSON, and the base64 inside it can be anything.
      const imageType = await fileTypeFromBuffer(parsed.imageBuffer);
      if (!imageType || !isAllowedMimeType('MAP', imageType.mime)) {
        return res.status(400).json({
          error: 'Validation Error',
          message:
            'The picture inside this file is not an image CozyVTT can use. ' +
            `Maps must be one of: ${ALLOWED_EXTENSIONS.MAP.join(', ')}.`,
        });
      }

      const mapSizeLimit = getFileSizeLimit('MAP');
      if (parsed.imageBuffer.length > mapSizeLimit) {
        const limitMB = Math.round(mapSizeLimit / (1024 * 1024));
        return res.status(400).json({
          error: 'Validation Error',
          message: `The picture inside this file is too large. Maps must be smaller than ${limitMB}MB.`,
        });
      }

      // ── Save the embedded image as an asset ──────────────────────────────
      const ext = `.${imageType.ext}`;
      const filename = `${randomUUID()}${ext}`;
      const uploadPath = getFilePath('MAP', 'CAMPAIGN', campaignId);
      await ensureDirectory(uploadPath);
      const filePath = path.join(uploadPath, filename).replace(/\\/g, '/');
      await fs.writeFile(filePath, parsed.imageBuffer);
      const thumbnailPath = await generateThumbnail(filePath);

      // Create asset record
      const asset = await prisma.asset.create({
        data: {
          type: 'MAP',
          scope: 'CAMPAIGN',
          uploadedById: userId,
          campaignId,
          filename,
          originalName: `${mapName}${ext}`,
          mimeType: imageType.mime,
          fileSize: parsed.imageBuffer.length,
          filePath,
          thumbnailPath,
          name: mapName,
          tags: ['uvtt-import'],
        },
      });

      const imageUrl = normalizeAssetUrl(asset.id, 'maps');

      // ── Create the map with walls and lights ─────────────────────────────
      const map = await prisma.map.create({
        data: {
          campaignId,
          name: mapName,
          imageUrl: imageUrl!,
          baseLayerUrl: imageUrl!,
          width: parsed.mapWidth,
          height: parsed.mapHeight,
          gridSize: gridSizePx,
          tokens: [],
          annotations: [],
          wallSegments: toJson(parsed.wallSegments),
          lights: toJson(parsed.lightSources),
          // Only when the file brings lights of its own. Walls alone used to
          // turn this on, which handed the DM a map that was black for every
          // player until they found the setting: walls block sight, and with
          // nothing lighting the room there is nothing to see.
          lightingEnabled: parsed.lightSources.length > 0,
        },
      });

      logger.info(
        `[uvtt-import] Created map "${mapName}" (${parsed.mapWidth}×${parsed.mapHeight}) ` +
        `with ${parsed.wallCount} walls + ${parsed.portalCount} doors + ${parsed.lightCount} lights`
      );

      return res.status(201).json({
        map,
        wallCount: parsed.wallCount,
        portalCount: parsed.portalCount,
        lightCount: parsed.lightCount,
        totalSegments: parsed.wallSegments.length,
      });
    } catch (error) {
      logger.error('Error importing UVTT file:', error);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to import UVTT file' });
    }
  }
);

/**
 * GET /api/campaigns/:campaignId/maps/:id/export-uvtt
 * Export a map as a Universal VTT (.uvtt) file download.
 * Includes the map image, wall segments, portals, and light sources.
 * Requires: DM role
 */
router.get(
  '/:id/export-uvtt',
  campaignDM,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { campaignId, id } = req.params;

      const map = await prisma.map.findFirst({
        where: { id, campaignId },
        select: {
          id: true,
          name: true,
          imageUrl: true,
          width: true,
          height: true,
          gridSize: true,
          wallSegments: true,
          lights: true,
        },
      });
      if (!map) {
        return res.status(404).json({ error: 'Not Found', message: 'Map not found' });
      }
      if (!map.imageUrl) {
        return res.status(422).json({ error: 'Unprocessable Entity', message: 'Map has no image' });
      }

      // Resolve asset file path
      const assetId = path.basename(map.imageUrl);
      const asset = await prisma.asset.findUnique({
        where: { id: assetId },
        select: { filePath: true },
      });
      if (!asset) {
        return res.status(422).json({ error: 'Unprocessable Entity', message: 'Map image asset not found' });
      }

      const imagePath = path.resolve(asset.filePath.replace(/\\/g, '/'));
      let imageBuffer: Buffer;
      try {
        imageBuffer = await fs.readFile(imagePath);
      } catch {
        return res.status(422).json({ error: 'Unprocessable Entity', message: 'Map image file not found on disk' });
      }

      // Get image dimensions for pixels_per_grid calculation
      const meta = await sharp(imageBuffer).metadata();
      const imageWidthPx = meta.width;

      const wallSegments = (Array.isArray(map.wallSegments) ? map.wallSegments : []) as unknown as WallSegment[];
      const lights = (Array.isArray(map.lights) ? map.lights : []) as unknown as LightSource[];

      const uvttBuffer = buildUVTT({
        mapWidth: map.width,
        mapHeight: map.height,
        gridSizePx: map.gridSize,
        wallSegments,
        lights,
        imageBuffer,
        imageWidthPx,
      });

      // Sanitize filename for Content-Disposition
      const safeName = map.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'map';
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.uvtt"`);
      res.setHeader('Content-Length', uvttBuffer.length);
      return res.send(uvttBuffer);
    } catch (error) {
      logger.error('Error exporting UVTT file:', error);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to export UVTT file' });
    }
  }
);

/**
 * GET /api/campaigns/:campaignId/maps/:id
 * Get a specific map with full data including tokens
 * Requires: Campaign membership
 *
 * Spirit Layer tokens filtered server-side
 * - DM always sees all tokens on both layers
 * - Players see spirit tokens only when spiritLayerEnabled is true
 * - Hidden tokens (visible: false) only visible to DM
 * - Dynamic lighting: players only get tokens in their line of sight
 * - Spirit layer URL hidden from non-privileged users
 */
router.get('/:id', campaignMember, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const userId = req.session.userId!;

    // Fetch the map
    const map = await prisma.map.findUnique({
      where: { id },
    });

    if (!map) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Map not found',
      });
    }

    // Verify map belongs to this campaign
    if (map.campaignId !== campaignId) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Map not found in this campaign',
      });
    }

    // Check user's role in campaign
    const membership = await prisma.campaignMembership.findUnique({
      where: {
        userId_campaignId: {
          userId,
          campaignId,
        },
      },
      select: { role: true },
    });

    if (!membership) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You are not a member of this campaign',
      });
    }

    // Get spirit layer visibility for this user
    const spiritVisible = await getSpiritVisibility(campaignId, userId);

    // Filter map data based on role and spirit visibility — and, for players on
    // a map with dynamic lighting, line of sight from their own tokens (those
    // they control or whose character they own or are assigned; same view as
    // map.changed)
    const ownCharacterIds =
      membership.role !== 'DM' && map.lightingEnabled
        ? (await getOwnCharacterIdsBatch(campaignId, [userId])).get(userId)
        : undefined;
    const responseMap = filterMapData(map, membership.role, spiritVisible, userId, ownCharacterIds);

    return res.status(200).json({ map: responseMap, spiritVisible });
  } catch (error) {
    logger.error('Error fetching map', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch map',
    });
  }
});

/**
 * PUT /api/campaigns/:campaignId/maps/:id/difficult-terrain
 * Replace the map's difficult terrain cells. Requires: DM role.
 */
router.put('/:id/difficult-terrain', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id: mapId } = req.params;
    const input = req.body?.cells;
    if (!Array.isArray(input)) {
      return res.status(400).json({ error: 'Validation Error', message: 'cells must be an array of grid coordinates' });
    }
    if (input.length > 100_000) {
      return res.status(400).json({ error: 'Validation Error', message: 'cells cannot contain more than 100000 entries' });
    }

    const result = await withCampaignMapRowLock(prisma, campaignId, mapId, async (tx, _campaign, map) => {
      const uniqueCells: Array<{ x: number; y: number }> = [];
      const seenCells = new Set<string>();
      for (const cell of input) {
        if (!isGridPosition(cell)) {
          return {
            status: 400 as const,
            body: { error: 'Validation Error', message: 'Each cell must have integer x and y values' },
          };
        }
        if (cell.x < 0 || cell.y < 0 || cell.x >= map.width || cell.y >= map.height) {
          return {
            status: 400 as const,
            body: { error: 'Validation Error', message: 'Each cell must be within map bounds' },
          };
        }
        const key = `${cell.x},${cell.y}`;
        if (!seenCells.has(key)) {
          seenCells.add(key);
          uniqueCells.push({ x: cell.x, y: cell.y });
        }
      }

      const updatedMap = await tx.map.update({
        where: { id: mapId },
        data: { difficultTerrain: uniqueCells as any },
      });
      return { status: 200 as const, body: { difficultTerrain: uniqueCells }, map: updatedMap };
    });

    if (result.status !== 200) return res.status(result.status).json(result.body);
    bumpMapVersion(mapId);
    try {
      await broadcastMapSnapshot(campaignId, result.map);
    } catch (error) {
      logger.warn('Failed to broadcast difficult terrain map change', { err: error, campaignId, mapId });
    }
    return res.status(200).json(result.body);
  } catch (error) {
    if (error instanceof CampaignRowNotFoundError || error instanceof MapRowNotFoundError) {
      return res.status(404).json({ error: 'Not Found', message: 'Map not found in this campaign' });
    }
    logger.error('Error updating difficult terrain', { err: error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to update difficult terrain' });
  }
});

/**
 * PUT /api/campaigns/:campaignId/maps/:id
 * Update a map
 * Requires: DM role
 */
router.put('/:id', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const { name, width, height, gridSize, imageUrl, spiritLayerUrl, feetPerSquare, diagonalRule, lightingEnabled } = req.body;

    // Fetch the map to verify it exists and belongs to campaign
    const existingMap = await prisma.map.findUnique({
      where: { id },
    });

    if (!existingMap) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Map not found',
      });
    }

    if (existingMap.campaignId !== campaignId) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Map not found in this campaign',
      });
    }

    // Build update data object.
    //
    // Typed rather than `any` because it is assembled field by field from
    // request body values: with `any`, a typo in one of these names compiled
    // and silently dropped that field from the update instead of saving it.
    const updateData: Prisma.MapUpdateInput = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Map name must be a non-empty string',
        });
      }
      updateData.name = name.trim();
    }

    if (width !== undefined) {
      if (typeof width !== 'number' || width <= 0) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Map width must be a positive number',
        });
      }
      updateData.width = width;
    }

    if (height !== undefined) {
      if (typeof height !== 'number' || height <= 0) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Map height must be a positive number',
        });
      }
      updateData.height = height;
    }

    if (gridSize !== undefined) {
      if (typeof gridSize !== 'number' || gridSize <= 0) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Grid size must be a positive number',
        });
      }
      updateData.gridSize = gridSize;
    }

    if (feetPerSquare !== undefined) {
      if (!Number.isInteger(feetPerSquare) || feetPerSquare < 1 || feetPerSquare > 100) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'feetPerSquare must be a positive integer between 1 and 100',
        });
      }
      updateData.feetPerSquare = feetPerSquare;
    }

    if (diagonalRule !== undefined) {
      if (diagonalRule !== 'flat' && diagonalRule !== 'alternating') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'diagonalRule must be "flat" or "alternating"',
        });
      }
      updateData.diagonalRule = diagonalRule;
    }

    if (imageUrl !== undefined) {
      if (typeof imageUrl !== 'string') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Image URL must be a string',
        });
      }
      // Normalize to full path
      const normalizedImageUrl = normalizeAssetUrl(imageUrl, 'maps');
      if (!normalizedImageUrl) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Invalid map imageUrl',
        });
      }
      updateData.imageUrl = normalizedImageUrl;
      updateData.baseLayerUrl = normalizedImageUrl; // Keep both in sync
    }

    if (spiritLayerUrl !== undefined) {
      // Allow null to clear spirit layer
      if (spiritLayerUrl !== null && typeof spiritLayerUrl !== 'string') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Spirit layer URL must be a string or null',
        });
      }
      // Normalize to full path (or null)
      updateData.spiritLayerUrl = spiritLayerUrl ? normalizeAssetUrl(spiritLayerUrl, 'maps') : null;
    }

    if (lightingEnabled !== undefined) {
      if (typeof lightingEnabled !== 'boolean') {
        return res.status(400).json({ error: 'Validation Error', message: 'lightingEnabled must be a boolean' });
      }
      updateData.lightingEnabled = lightingEnabled;
    }

    // Update the map
    const updatedMap = await prisma.map.update({
      where: { id },
      data: updateData,
    });

    // Broadcast lighting change so all connected clients update immediately
    if (updateData.lightingEnabled !== undefined) {
      try {
        broadcastToCampaign(campaignId, 'map:lighting:updated', {
          mapId: id,
          lightingEnabled: updatedMap.lightingEnabled,
        });
      } catch { /* non-fatal */ }
    }
    // Lighting, size or grid changes move what players see on a lighting map.
    if (updateData.lightingEnabled !== undefined || updateData.width !== undefined || updateData.height !== undefined || updateData.gridSize !== undefined) {
      await broadcastMapViewChange(campaignId, id, {
        lightingEnabled: existingMap.lightingEnabled,
        width: existingMap.width,
        height: existingMap.height,
        gridSize: existingMap.gridSize,
      });
    }

    return res.status(200).json({ map: updatedMap });
  } catch (error) {
    logger.error('Error updating map', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update map',
    });
  }
});

/**
 * DELETE /api/campaigns/:campaignId/maps/:id
 * Delete a map
 * Requires: DM role
 * Cannot delete if it's the current map
 */
router.delete('/:id', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const result = await withCampaignMapRowLock(prisma, campaignId, id, async (tx, campaign, map) => {
      const combatState = readCombatState(campaign.combatState);
      if (combatState.active && combatState.mapId === id) {
        return {
          status: 409 as const,
          body: { error: 'Conflict', message: 'Cannot delete the map used by active combat' },
        };
      }
      if (campaign.currentMapId === id) {
        return {
          status: 400 as const,
          body: {
            error: 'Validation Error',
            message: 'Cannot delete the current map. Set a different map as current first.',
          },
        };
      }

      await tx.map.delete({ where: { id: map.id } });
      return { status: 200 as const, body: { message: 'Map deleted successfully' } };
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof CampaignRowNotFoundError || error instanceof MapRowNotFoundError) {
      return res.status(404).json({ error: 'Not Found', message: 'Map not found in this campaign' });
    }
    logger.error('Error deleting map', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete map',
    });
  }
});

/**
 * PUT /api/campaigns/:campaignId/maps/:id/set-current
 * Set a map as the current map for the campaign
 * Requires: DM role
 */
router.put('/:id/set-current', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const result = await withCampaignMapRowLock(prisma, campaignId, id, async (tx, campaign, map) => {
      const combatState = readCombatState(campaign.combatState);
      if (combatState.active && combatState.mapId !== map.id) {
        return {
          status: 409 as const,
          body: { error: 'Conflict', message: 'Cannot switch maps away from the map used by active combat' },
        };
      }

      const updatedCampaign = await tx.campaign.update({
        where: { id: campaignId },
        data: { currentMapId: map.id },
        include: {
          currentMap: {
            select: {
              id: true,
              name: true,
              imageUrl: true,
            },
          },
        },
      });
      return { status: 200 as const, body: { message: 'Current map updated successfully', campaign: updatedCampaign } };
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof CampaignRowNotFoundError || error instanceof MapRowNotFoundError) {
      return res.status(404).json({ error: 'Not Found', message: 'Map not found in this campaign' });
    }
    logger.error('Error setting current map', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to set current map',
    });
  }
});

// ============================================
// TOKEN MANIPULATION ENDPOINTS
// ============================================

/**
 * POST /api/campaigns/:campaignId/maps/:id/tokens
 * Add a new token to the map
 * Requires: DM role
 *
 * Token Schema:
 * {
 *   id: string (UUID),
 *   characterId?: string,
 *   name: string,
 *   imageUrl: string,
 *   position: { x: number, y: number },
 *   size: { width: number, height: number },
 *   layer: "token" | "spirit",
 *   visible: boolean,
 *   controlledBy?: string,
 *   rotation: number,
 *   conditions: string[],
 *   metadata: object
 * }
 */
router.post('/:id/tokens', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id: mapId } = req.params;
    const tokenData = req.body;
    const result = await withCampaignMapRowLock(prisma, campaignId, mapId, async (tx, _campaign, map) => {
      if (!tokenData.name || typeof tokenData.name !== 'string') {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Token name is required' } };
      }

      // imageUrl is optional — tokens without an image get colored-letter placeholders.
      if (tokenData.imageUrl && typeof tokenData.imageUrl !== 'string') {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Token imageUrl must be a string if provided' } };
      }

      if (!tokenData.position || typeof tokenData.position.x !== 'number' || typeof tokenData.position.y !== 'number') {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Token position {x, y} is required' } };
      }

      if (tokenData.position.x < 0 || tokenData.position.x >= map.width ||
          tokenData.position.y < 0 || tokenData.position.y >= map.height) {
        return {
          status: 400 as const,
          body: {
            error: 'Validation Error',
            message: `Token position must be within map bounds (0-${map.width - 1}, 0-${map.height - 1})`,
          },
        };
      }

      const layer = tokenData.layer || 'token';
      if (layer !== 'token' && layer !== 'spirit') {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Token layer must be "token" or "spirit"' } };
      }

      const tokenType = tokenData.type || 'npc';
      if (!VALID_TOKEN_TYPES.includes(tokenType)) {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Invalid token type' } };
      }
      const disposition = tokenData.disposition !== undefined ? tokenData.disposition : null;
      if (disposition !== null && !VALID_TOKEN_DISPOSITIONS.includes(disposition)) {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Invalid token disposition' } };
      }

      const displayMode = tokenData.displayMode || 'pog';
      if (!VALID_DISPLAY_MODES.includes(displayMode)) {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Invalid display mode' } };
      }

      const shapes = validateTokenShapes(tokenData);
      if (!shapes.ok) return { status: 400 as const, body: { error: 'Validation Error', message: shapes.message } };

      const normalizedTokenImageUrl = tokenData.imageUrl
        ? normalizeAssetUrl(tokenData.imageUrl, 'tokens')
        : null;
      const newToken = {
        id: randomUUID(),
        characterId: tokenData.characterId || null,
        name: tokenData.name,
        imageUrl: normalizedTokenImageUrl || '',
        position: { x: tokenData.position.x, y: tokenData.position.y },
        size: shapes.value.size ?? { width: 1, height: 1 },
        layer,
        visible: tokenData.visible !== undefined ? tokenData.visible : true,
        controlledBy: tokenData.controlledBy || null,
        rotation: tokenData.rotation || 0,
        conditions: shapes.value.conditions ?? [],
        metadata: shapes.value.metadata ?? {},
        type: tokenType,
        disposition,
        hp: shapes.value.hp ?? null,
        showHpBar: tokenData.showHpBar !== undefined ? tokenData.showHpBar : false,
        notes: typeof tokenData.notes === 'string' ? tokenData.notes : '',
        initiative: tokenData.initiative !== undefined ? tokenData.initiative : null,
        displayMode,
        statBlock: shapes.value.statBlock ?? null,
        creatureTemplateId: tokenData.creatureTemplateId || null,
      };

      const tokensArray = (Array.isArray(map.tokens) ? map.tokens : []) as unknown as Token[];
      const updatedMap = await tx.map.update({
        where: { id: mapId },
        data: { tokens: [...tokensArray, newToken] as any },
      });
      return {
        status: 201 as const,
        body: { message: 'Token added successfully', token: newToken, map: updatedMap },
        token: newToken,
      };
    });

    if (result.status !== 201) return res.status(result.status).json(result.body);

    // Live update for every client viewing this map (hidden tokens: DM only)
    await broadcastTokenEvent(campaignId, mapId, null, result.token);
    return res.status(201).json(result.body);
  } catch (error) {
    if (error instanceof CampaignRowNotFoundError || error instanceof MapRowNotFoundError) {
      return res.status(404).json({ error: 'Not Found', message: 'Map not found in this campaign' });
    }
    logger.error('Error adding token', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to add token',
    });
  }
});

/**
 * PUT /api/campaigns/:campaignId/maps/:id/tokens/:tokenId
 * Update an existing token on the map
 * Requires: DM role OR player controlling the token
 *
 * DM can update any token
 * Players can only update tokens where controlledBy matches their userId
 */
router.put('/:id/tokens/:tokenId', campaignMember, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id: mapId, tokenId } = req.params;
    const userId = req.session.userId!;
    const updates = req.body ?? {};
    if (typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Validation Error', message: 'Token updates must be an object' });
    }

    const result = await withCampaignMapRowLock(prisma, campaignId, mapId, async (tx, campaign, map) => {
      const membership = await tx.campaignMembership.findUnique({
        where: { userId_campaignId: { userId, campaignId } },
      });
      if (!membership) {
        return { status: 403 as const, body: { error: 'Forbidden', message: 'You are not a member of this campaign' } };
      }

      const tokensArray = (Array.isArray(map.tokens) ? map.tokens : []) as unknown as Token[];
      const tokenIndex = tokensArray.findIndex((token) => token.id === tokenId);
      if (tokenIndex === -1) {
        return { status: 404 as const, body: { error: 'Not Found', message: 'Token not found on this map' } };
      }

      const existingToken = tokensArray[tokenIndex];
      const isDM = membership.role === 'DM';
      const controlsToken = existingToken.controlledBy === userId;
      if (!isDM && !controlsToken) {
        return { status: 403 as const, body: { error: 'Forbidden', message: 'You can only update tokens you control' } };
      }

      const combatActive = readCombatState(campaign.combatState).active;
      if (updates.position !== undefined && combatActive) {
        return {
          status: 409 as const,
          body: {
            error: 'Conflict',
            message: 'Token movement during combat must use the committed token.move.end socket event',
          },
        };
      }

      if (combatActive && !isDM && (updates.size !== undefined || updates.conditions !== undefined)) {
        return {
          status: 403 as const,
          body: { error: 'Forbidden', message: 'Only DM can change token size or conditions during combat' },
        };
      }

      if (updates.size !== undefined && !isTokenSize(updates.size)) {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Token size must have positive integer width and height' } };
      }
      if (updates.conditions !== undefined &&
          (!Array.isArray(updates.conditions) || updates.conditions.some((condition: unknown) => typeof condition !== 'string'))) {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Token conditions must be an array of strings' } };
      }

      const nextPosition = updates.position !== undefined ? updates.position : existingToken.position;
      const nextSize = updates.size !== undefined ? updates.size : (existingToken.size ?? { width: 1, height: 1 });
      if (updates.position !== undefined && !isGridPosition(updates.position)) {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Position must have integer x and y values' } };
      }
      if (updates.position !== undefined || updates.size !== undefined) {
        if (!isGridPosition(nextPosition) || !isTokenSize(nextSize)) {
          return { status: 400 as const, body: { error: 'Validation Error', message: 'Token position and size must be valid grid values' } };
        }
        if (!footprintFitsMap(nextPosition, nextSize, map)) {
          return {
            status: 400 as const,
            body: { error: 'Validation Error', message: 'Token footprint must fit within map bounds' },
          };

        }
      }

      if (updates.layer !== undefined) {
        if (!isDM) return { status: 403 as const, body: { error: 'Forbidden', message: 'Only DM can change token layer' } };
        if (updates.layer !== 'token' && updates.layer !== 'spirit') {
          return { status: 400 as const, body: { error: 'Validation Error', message: 'Layer must be "token" or "spirit"' } };
        }
      }

      if (updates.type !== undefined && !VALID_TOKEN_TYPES.includes(updates.type)) {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Invalid token type' } };
      }
      if (updates.disposition !== undefined && updates.disposition !== null && !VALID_TOKEN_DISPOSITIONS.includes(updates.disposition)) {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Invalid token disposition' } };
      }
      if (updates.displayMode !== undefined && !VALID_DISPLAY_MODES.includes(updates.displayMode)) {
        return { status: 400 as const, body: { error: 'Validation Error', message: 'Invalid display mode' } };
      }

      if (!isDM) {
        const restrictedFields = ['hp', 'notes', 'showHpBar', 'type', 'disposition', 'initiative', 'visible', 'name', 'imageUrl', 'layer', 'controlledBy', 'displayMode', 'statBlock', 'creatureTemplateId', 'metadata'];
        for (const field of restrictedFields) {
          if (updates[field] !== undefined) {
            return { status: 403 as const, body: { error: 'Forbidden', message: `Only DM can update token field: ${field}` } };
          }
        }
      }

      const shapes = validateTokenShapes(updates);
      if (!shapes.ok) return { status: 400 as const, body: { error: 'Validation Error', message: shapes.message } };
      const mergedMetadata = shapes.value.metadata
        ? { ...existingToken.metadata, ...shapes.value.metadata }
        : undefined;
      if (mergedMetadata) {
        const merged = TokenMetadataSchema.safeParse(mergedMetadata);
        if (!merged.success) return {
          status: 400 as const,
          body: { error: 'Validation Error', message: `Invalid token metadata: ${merged.error.issues[0]?.message ?? 'invalid'}` },
        };
      }

      const updatedToken: Token = {
        ...existingToken,
        ...(updates.name && { name: updates.name }),
        ...(updates.imageUrl !== undefined && { imageUrl: updates.imageUrl ? (normalizeAssetUrl(updates.imageUrl, 'tokens') || existingToken.imageUrl) : '' }),
        ...(updates.position !== undefined && { position: updates.position }),
        ...(updates.size !== undefined && { size: shapes.value.size }),
        ...(updates.layer && { layer: updates.layer }),
        ...(updates.visible !== undefined && { visible: updates.visible }),
        ...(updates.controlledBy !== undefined && { controlledBy: updates.controlledBy }),
        ...(updates.rotation !== undefined && { rotation: updates.rotation }),
        ...(updates.conditions !== undefined && { conditions: shapes.value.conditions }),
        ...(mergedMetadata && { metadata: mergedMetadata }),
        ...(updates.type !== undefined && { type: updates.type }),
        ...(updates.disposition !== undefined && { disposition: updates.disposition }),
        ...(updates.hp !== undefined && { hp: shapes.value.hp ?? null }),
        ...(updates.showHpBar !== undefined && { showHpBar: updates.showHpBar }),
        ...(updates.notes !== undefined && { notes: updates.notes }),
        ...(updates.initiative !== undefined && { initiative: updates.initiative }),
        ...(updates.displayMode !== undefined && { displayMode: updates.displayMode }),
        ...(updates.statBlock !== undefined && { statBlock: shapes.value.statBlock ?? null }),
        ...(updates.creatureTemplateId !== undefined && { creatureTemplateId: updates.creatureTemplateId }),
      };

      const updatedTokens = [...tokensArray];
      updatedTokens[tokenIndex] = updatedToken;
      await tx.map.update({ where: { id: mapId }, data: { tokens: updatedTokens as any } });

      let responseToken: Token = updatedToken;
      if (membership.role !== 'DM') {
        const { notes: _notes, ...playerToken } = updatedToken;
        responseToken = playerToken as Token;
      }
      return {
        status: 200 as const,
        body: { message: 'Token updated successfully', token: responseToken },
        existingToken,
        updatedToken,
      };

    });

    if (result.status !== 200) return res.status(result.status).json(result.body);
    await broadcastTokenEvent(campaignId, mapId, result.existingToken, result.updatedToken);
    return res.status(200).json(result.body);
  } catch (error) {
    if (error instanceof CampaignRowNotFoundError || error instanceof MapRowNotFoundError) {
      return res.status(404).json({ error: 'Not Found', message: 'Map not found in this campaign' });
    }
    logger.error('Error updating token', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update token',
    });
  }
});

/**
 * DELETE /api/campaigns/:campaignId/maps/:id/tokens/:tokenId
 * Remove a token from the map
 * Requires: DM role
 */
router.delete('/:id/tokens/:tokenId', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id: mapId, tokenId } = req.params;
    const result = await withCampaignMapRowLock(prisma, campaignId, mapId, async (tx, _campaign, map) => {
      const tokensArray = (Array.isArray(map.tokens) ? map.tokens : []) as unknown as Token[];
      const tokenIndex = tokensArray.findIndex((token) => token.id === tokenId);
      if (tokenIndex === -1) {
        return { status: 404 as const, body: { error: 'Not Found', message: 'Token not found on this map' } };
      }

      const removedToken = tokensArray[tokenIndex];
      await tx.map.update({
        where: { id: mapId },
        data: { tokens: tokensArray.filter((token) => token.id !== tokenId) as any },
      });
      return { status: 200 as const, body: { message: 'Token removed successfully' }, removedToken };
    });

    if (result.status !== 200) return res.status(result.status).json(result.body);

    // Live update (removal of a hidden token reaches DMs only)
    await broadcastTokenEvent(campaignId, mapId, result.removedToken, null);
    return res.status(200).json(result.body);
  } catch (error) {
    if (error instanceof CampaignRowNotFoundError || error instanceof MapRowNotFoundError) {
      return res.status(404).json({ error: 'Not Found', message: 'Map not found in this campaign' });
    }
    logger.error('Error removing token', { err: error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to remove token',
    });
  }
});

// ============================================================
// WALL SEGMENT ENDPOINTS// All write endpoints require DM role.
// ============================================================

/**
 * Helper: verify map belongs to campaign and return it, or send error response.
 * Returns null if a response was already sent.
 */
async function findMapInCampaign(
  campaignId: string,
  mapId: string,
  res: Response
) {
  const map = await prisma.map.findUnique({ where: { id: mapId } });
  if (!map) {
    res.status(404).json({ error: 'Not Found', message: 'Map not found' });
    return null;
  }
  if (map.campaignId !== campaignId) {
    res.status(404).json({ error: 'Not Found', message: 'Map not found in this campaign' });
    return null;
  }
  return map;
}

/**
 * Helper: build a default all-hidden FogState from map dimensions.
 * One cell per grid square so fog aligns with the visible grid.
 */
function buildDefaultFogState(map: { width: number; height: number; gridSize: number }): FogState {
  const cellPx = map.gridSize; // one fog cell = one grid square
  const fogCols = map.width;   // grid columns
  const fogRows = map.height;  // grid rows
  return {
    fogCols,
    fogRows,
    cellPx,
    revealed: new Array(fogCols * fogRows).fill(false),
  };
}

/**
 * Load fog from DB, rebuilding if the stored cell size doesn't match the current grid.
 */
function loadFogState(map: { width: number; height: number; gridSize: number }, stored: FogState | null): FogState {
  const expected = buildDefaultFogState(map);
  if (!stored || stored.cellPx !== expected.cellPx || stored.fogCols !== expected.fogCols || stored.fogRows !== expected.fogRows) {
    return expected;
  }
  return stored;
}

/**
 * Helper: apply a FogOperation to an existing FogState, mutating revealed in-place.
 * Out-of-bounds indices are silently ignored.
 */
function applyFogOperation(fog: FogState, operation: { op: string; cells?: number[] }): void {
  const total = fog.fogCols * fog.fogRows;
  switch (operation.op) {
    case 'reveal_all':
      fog.revealed.fill(true);
      break;
    case 'hide_all':
      fog.revealed.fill(false);
      break;
    case 'reveal':
      for (const idx of (operation.cells ?? [])) {
        if (idx >= 0 && idx < total) fog.revealed[idx] = true;
      }
      break;
    case 'hide':
      for (const idx of (operation.cells ?? [])) {
        if (idx >= 0 && idx < total) fog.revealed[idx] = false;
      }
      break;
  }
}

/**
 * GET /api/campaigns/:campaignId/maps/:id/walls
 * Return the map's wall segments array (all roles).
 */
router.get('/:id/walls', campaignMember, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;
    const segments = (Array.isArray(map.wallSegments) ? map.wallSegments : []) as unknown as WallSegment[];
    return res.status(200).json({ segments });
  } catch (error) {
    logger.error('Error fetching wall segments', { err: error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch wall segments' });
  }
});

/**
 * PUT /api/campaigns/:campaignId/maps/:id/walls
 * Replace the entire wall segments array (DM only).
 * Body: { segments: WallSegment[] }
 */
router.put('/:id/walls', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    const parsed = WallSegmentsArraySchema.safeParse(req.body.segments);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation Error', message: parsed.error.issues[0]?.message ?? 'Invalid segments' });
    }

    const updated = await prisma.map.update({
      where: { id },
      data: { wallSegments: toJson(parsed.data) },
    });
    await broadcastMapViewChange(campaignId, id, { wallSegments: map.wallSegments });

    return res.status(200).json({ segments: updated.wallSegments });
  } catch (error) {
    logger.error('Error replacing wall segments', { err: error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to update wall segments' });
  }
});

/**
 * POST /api/campaigns/:campaignId/maps/:id/walls
 * Add a single wall segment (DM only).
 * Body: WallSegment (id generated server-side if missing)
 */
router.post('/:id/walls', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    const segmentData = { ...req.body, id: req.body.id || randomUUID() };
    const parsed = WallSegmentSchema.safeParse(segmentData);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation Error', message: parsed.error.issues[0]?.message ?? 'Invalid segment' });
    }

    const existing = (Array.isArray(map.wallSegments) ? map.wallSegments : []) as unknown as WallSegment[];
    if (existing.length >= 5000) {
      return res.status(400).json({ error: 'Limit Exceeded', message: 'Maximum 5000 wall segments per map' });
    }

    const updated = await prisma.map.update({
      where: { id },
      data: { wallSegments: toJson([...existing, parsed.data]) },
    });
    await broadcastMapViewChange(campaignId, id, { wallSegments: existing });

    return res.status(201).json({ segment: parsed.data, total: (updated.wallSegments as unknown as WallSegment[]).length });
  } catch (error) {
    logger.error('Error adding wall segment', { err: error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to add wall segment' });
  }
});

/**
 * DELETE /api/campaigns/:campaignId/maps/:id/walls/:sid
 * Remove a wall segment by id (DM only).
 */
router.delete('/:id/walls/:sid', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id, sid } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    const existing = (Array.isArray(map.wallSegments) ? map.wallSegments : []) as unknown as WallSegment[];
    const filtered = existing.filter((s) => s.id !== sid);

    if (filtered.length === existing.length) {
      return res.status(404).json({ error: 'Not Found', message: 'Wall segment not found' });
    }

    await prisma.map.update({ where: { id }, data: { wallSegments: filtered as any } });
    await broadcastMapViewChange(campaignId, id, { wallSegments: existing });
    return res.status(200).json({ message: 'Wall segment deleted' });
  } catch (error) {
    logger.error('Error deleting wall segment', { err: error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to delete wall segment' });
  }
});

/**
 * PATCH /api/campaigns/:campaignId/maps/:id/walls/:sid
 * Update a single wall segment's type (DM only) — e.g., toggle door open/closed.
 * Body: { type: WallType }
 */
router.patch('/:id/walls/:sid', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id, sid } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    const validTypes = ['wall', 'door-closed', 'door-open', 'window'];
    if (!req.body.type || !validTypes.includes(req.body.type)) {
      return res.status(400).json({ error: 'Validation Error', message: `type must be one of: ${validTypes.join(', ')}` });
    }

    const existing = (Array.isArray(map.wallSegments) ? map.wallSegments : []) as unknown as WallSegment[];
    const segIndex = existing.findIndex((s) => s.id === sid);

    if (segIndex === -1) {
      return res.status(404).json({ error: 'Not Found', message: 'Wall segment not found' });
    }

    const previous = [...existing];
    existing[segIndex] = { ...existing[segIndex], type: req.body.type };
    await prisma.map.update({ where: { id }, data: { wallSegments: existing as any } });
    // An opened or closed door changes what players see on a lighting map.
    await broadcastMapViewChange(campaignId, id, { wallSegments: previous });

    return res.status(200).json({ segment: existing[segIndex] });
  } catch (error) {
    logger.error('Error updating wall segment', { err: error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to update wall segment' });
  }
});

// ============================================================
// LIGHT SOURCE ENDPOINTS
// ============================================================

/**
 * GET /api/campaigns/:campaignId/maps/:id/lights
 * Return the map's light sources array (all campaign members).
 */
router.get('/:id/lights', campaignMember, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;
    const lights = (Array.isArray(map.lights) ? map.lights : []) as unknown as LightSource[];
    return res.status(200).json({ lights });
  } catch (error) {
    logger.error('Error fetching light sources:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch light sources' });
  }
});

/**
 * PUT /api/campaigns/:campaignId/maps/:id/lights
 * Replace the entire light sources array (DM only).
 * Body: { lights: LightSource[] }
 */
router.put('/:id/lights', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    const parsed = LightSourcesArraySchema.safeParse(req.body.lights);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation Error', message: parsed.error.issues[0]?.message ?? 'Invalid lights array' });
    }

    const updated = await prisma.map.update({
      where: { id },
      data: { lights: toJson(parsed.data) },
    });

    broadcastToCampaign(campaignId, 'lights:replaced', { mapId: id, lights: updated.lights });
    await broadcastMapViewChange(campaignId, id, { lights: map.lights });
    return res.status(200).json({ lights: updated.lights });
  } catch (error) {
    logger.error('Error replacing light sources:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to update light sources' });
  }
});

/**
 * POST /api/campaigns/:campaignId/maps/:id/lights
 * Add a single light source (DM only).
 * Body: LightSource (id generated server-side if missing)
 */
router.post('/:id/lights', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    const lightData = { ...req.body, id: req.body.id || randomUUID() };
    const parsed = LightSourceSchema.safeParse(lightData);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation Error', message: parsed.error.issues[0]?.message ?? 'Invalid light source' });
    }

    const existing = (Array.isArray(map.lights) ? map.lights : []) as unknown as LightSource[];
    if (existing.length >= 200) {
      return res.status(400).json({ error: 'Limit Exceeded', message: 'Maximum 200 light sources per map' });
    }

    const updated = await prisma.map.update({
      where: { id },
      data: { lights: toJson([...existing, parsed.data]) },
    });

    broadcastToCampaign(campaignId, 'light:added', { mapId: id, light: parsed.data });
    await broadcastMapViewChange(campaignId, id, { lights: existing });
    return res.status(201).json({ light: parsed.data, total: (updated.lights as unknown as LightSource[]).length });
  } catch (error) {
    logger.error('Error adding light source:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to add light source' });
  }
});

/**
 * PATCH /api/campaigns/:campaignId/maps/:id/lights/:lightId
 * Update a single light source (DM only).
 * Body: Partial<LightSource> (at least one field required)
 */
router.patch('/:id/lights/:lightId', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id, lightId } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    const parsed = LightSourceUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation Error', message: parsed.error.issues[0]?.message ?? 'Invalid update data' });
    }

    const existing = (Array.isArray(map.lights) ? map.lights : []) as unknown as LightSource[];
    const idx = existing.findIndex((l) => l.id === lightId);
    if (idx === -1) {
      return res.status(404).json({ error: 'Not Found', message: 'Light source not found' });
    }

    const previous = [...existing];
    existing[idx] = { ...existing[idx], ...parsed.data };
    await prisma.map.update({ where: { id }, data: { lights: toJson(existing) } });

    broadcastToCampaign(campaignId, 'light:updated', { mapId: id, light: existing[idx] });
    await broadcastMapViewChange(campaignId, id, { lights: previous });
    return res.status(200).json({ light: existing[idx] });
  } catch (error) {
    logger.error('Error updating light source:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to update light source' });
  }
});

/**
 * DELETE /api/campaigns/:campaignId/maps/:id/lights/:lightId
 * Remove a light source by id (DM only).
 */
router.delete('/:id/lights/:lightId', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id, lightId } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    const existing = (Array.isArray(map.lights) ? map.lights : []) as unknown as LightSource[];
    const filtered = existing.filter((l) => l.id !== lightId);

    if (filtered.length === existing.length) {
      return res.status(404).json({ error: 'Not Found', message: 'Light source not found' });
    }

    await prisma.map.update({ where: { id }, data: { lights: toJson(filtered) } });

    broadcastToCampaign(campaignId, 'light:removed', { mapId: id, lightId });
    await broadcastMapViewChange(campaignId, id, { lights: existing });
    return res.status(200).json({ message: 'Light source deleted' });
  } catch (error) {
    logger.error('Error deleting light source:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to delete light source' });
  }
});

// ============================================================
// FOG OF WAR ENDPOINTS// ============================================================

/**
 * GET /api/campaigns/:campaignId/maps/:id/fog
 * Return full FogState for this map (DM only).
 */
router.get('/:id/fog', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    const fog = loadFogState(map, map.fogData as FogState | null);
    return res.status(200).json({ fogState: fog });
  } catch (error) {
    logger.error('Error fetching fog state', { err: error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch fog state' });
  }
});

/**
 * POST /api/campaigns/:campaignId/maps/:id/fog/operation
 * Apply a FogOperation to the fog state (DM only).
 * Body: FogOperation
 * Returns the updated FogState.
 */
router.post('/:id/fog/operation', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    const parsed = FogOperationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation Error', message: parsed.error.issues[0]?.message ?? 'Invalid fog operation' });
    }

    const fog: FogState = loadFogState(map, map.fogData as FogState | null);

    applyFogOperation(fog, parsed.data);

    const updated = await prisma.map.update({
      where: { id },
      data: { fogData: toJson(fog) },
    });

    return res.status(200).json({ fogState: updated.fogData });
  } catch (error) {
    logger.error('Error applying fog operation', { err: error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to apply fog operation' });
  }
});

/**
 * PUT /api/campaigns/:campaignId/maps/:id/lighting
 * Toggle dynamic lighting enabled/disabled (DM only).
 * Body: { enabled: boolean }
 */
router.put('/:id/lighting', campaignDM, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { campaignId, id } = req.params;
    const map = await findMapInCampaign(campaignId, id, res);
    if (!map) return;

    if (typeof req.body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'Validation Error', message: 'enabled must be a boolean' });
    }

    const updated = await prisma.map.update({
      where: { id },
      data: { lightingEnabled: req.body.enabled },
    });

    // Broadcast to all clients in this campaign so they don't need to reload
    try {
      broadcastToCampaign(campaignId, 'map:lighting:updated', {
        mapId: id,
        lightingEnabled: updated.lightingEnabled,
      });
    } catch {
      // Socket may not be initialized in tests — log and continue
    }
    // Players gain (lighting off) or lose (lighting on) the tokens outside their sight.
    await broadcastMapViewChange(campaignId, id, { lightingEnabled: map.lightingEnabled });

    return res.status(200).json({ lightingEnabled: updated.lightingEnabled });
  } catch (error) {
    logger.error('Error updating lighting setting', { err: error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to update lighting setting' });
  }
});

export default router;
