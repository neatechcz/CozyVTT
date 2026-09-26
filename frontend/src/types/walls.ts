/**
 * Wall and Fog of War Types — Frontend
 *
 * IMPORTANT: Keep this file in sync with backend/src/types/walls.ts.
 * These types define the data structures for the wall segment and fog of war
 * systems. Any changes here must be mirrored in the backend type file.
 */

// ── Wall Segments ─────────────────────────────────────────────────────────────

export type WallType = 'wall' | 'door-closed' | 'door-open' | 'door-locked' | 'window';

export interface WallSegment {
  id: string;   // UUID, assigned on creation
  x1: number;   // map-space pixels, origin top-left
  y1: number;
  x2: number;
  y2: number;
  type: WallType;
}

// ── Wall Socket Events ───────────────────────────────────────────────────────

/**
 * Origin of a wall broadcast, so a receiving client can tell its own
 * optimistic echo from a change made by another client (another DM socket,
 * the AI narrator's MCP service account, or a player toggling an unlocked
 * door). Both are absent on an older backend and on the `walls:request`
 * reply (a sync, not a change).
 */
export interface WallEventOrigin {
  changedBy?: string;      // socket.userId of the sender, mirrors token.moved's movedBy
  sourceSocketId?: string; // socket.id of the sender
}

export interface WallAddedEvent extends WallEventOrigin {
  mapId: string;
  segment: WallSegment;
}

export interface WallRemovedEvent extends WallEventOrigin {
  mapId: string;
  segmentId: string;
}

export interface WallUpdatedEvent extends WallEventOrigin {
  mapId: string;
  segment: WallSegment;
}

export interface WallsReplacedEvent extends WallEventOrigin {
  mapId: string;
  segments: WallSegment[];
}

// ── Fog of War ────────────────────────────────────────────────────────────────

/**
 * Fog state: a flat array of booleans, one per fog cell.
 * Cell (col, row) maps to index: row * fogCols + col.
 * true = revealed to players, false = hidden.
 */
export interface FogState {
  fogCols: number;     // number of fog cells horizontally
  fogRows: number;     // number of fog cells vertically
  cellPx: number;      // fog cell size in map pixels (default 32)
  revealed: boolean[]; // length = fogCols * fogRows
}

export type FogOperation =
  | { op: 'reveal'; cells: number[] }   // cell indices to reveal
  | { op: 'hide'; cells: number[] }     // cell indices to hide
  | { op: 'reveal_all' }
  | { op: 'hide_all' };

// ── Light Sources ────────────────────────────────────────────────────────────

export interface LightSource {
  id: string;          // UUID, assigned on creation
  x: number;           // map-space pixels, origin top-left
  y: number;
  brightRadius: number; // bright-light radius in grid squares (full visibility, strong glow)
  dimRadius: number;    // dim-light radius in grid squares (lightly obscured, faint glow; >= brightRadius)
  color: string;        // hex color e.g. '#ffcc66' (warm amber default)
  enabled: boolean;     // toggle without deleting (extinguished torch)
}
