// ============================================
// In-process map versions
//
// Every writer that changes what a map shows or who sees it bumps its
// version: broadcastTokenEvent, broadcastMapViewChange, token.move.end, the
// map.change and spirit_layer.toggle socket paths, the campaign PUT when it
// writes spiritLayerEnabled, session restore, and initiative.set /
// initiative.roll. Cached per-drag snapshots (token movement handlers: the
// map and the room's viewers) compare the version and reload on the next
// frame when it changed.
//
// Not covered — the drag cache then expires by time (DRAG_CONTEXT_TTL_MS,
// 500 ms):
// - Membership and assignment changes (role, characterIds, joins), which
//   change a viewer's inputs without writing the map.
// - Other backend instances: versions are in-process, so a write on another
//   instance does not bump this one's.
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
