// ============================================
// In-process map versions
//
// Every writer that changes what a map shows (tokens, walls, doors, lights,
// lighting, the map switch) bumps its version — broadcastTokenEvent,
// broadcastMapViewChange, token.move.end and the map.change / spirit toggle
// paths. Cached per-drag map snapshots (token movement handlers) compare the
// version and reload on the next frame when it changed.
//
// In-process only: with several backend instances, a write on another
// instance does not bump this one's version (its drag cache then expires by
// time, DRAG_CONTEXT_TTL_MS).
// ============================================

const versions = new Map<string, number>();

/** Mark the map as changed: cached snapshots of it are stale. */
export function bumpMapVersion(mapId: string): void {
  versions.set(mapId, (versions.get(mapId) ?? 0) + 1);
}

/** The map's current in-process version (0 until its first bump). */
export function getMapVersion(mapId: string): number {
  return versions.get(mapId) ?? 0;
}
