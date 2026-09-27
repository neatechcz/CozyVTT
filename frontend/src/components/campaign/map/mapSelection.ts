// ============================================
// Selecting things on a map
//
// The rubber-band box and what it catches. Map pixels, top-left origin, the
// same space wall segments are stored in.
//
// Unlike the fog box (see fogSelection.ts) this one does not snap to the grid:
// a wall can sit anywhere, so the box has to be able to as well.
// ============================================

import type { WallSegment } from '@/types/walls';
import type { Point } from './mapGeometry';

export interface SelectionRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The rectangle between two drag corners.
 *
 * Normalised, so dragging up and to the left gives the same box as dragging
 * down and to the right.
 */
export function rectFromDrag(ax: number, ay: number, bx: number, by: number): SelectionRect {
  return {
    minX: Math.min(ax, bx),
    minY: Math.min(ay, by),
    maxX: Math.max(ax, bx),
    maxY: Math.max(ay, by),
  };
}

/** Whether a point lies in the rectangle, edges included. */
export function pointInRect(point: Point, rect: SelectionRect): boolean {
  return (
    point.x >= rect.minX && point.x <= rect.maxX && point.y >= rect.minY && point.y <= rect.maxY
  );
}

/** Whether two segments cross, using the sign of their orientations. */
function segmentsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);

  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * Whether a wall touches the rectangle at all.
 *
 * A wall counts when either end is inside, and also when it passes straight
 * through with both ends outside, which is what a box drawn across a corridor
 * is meant to catch.
 */
export function segmentIntersectsRect(seg: WallSegment, rect: SelectionRect): boolean {
  const a = { x: seg.x1, y: seg.y1 };
  const b = { x: seg.x2, y: seg.y2 };
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true;

  const corners: Point[] = [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ];
  return corners.some((corner, i) => segmentsCross(a, b, corner, corners[(i + 1) % 4]));
}

/** The ids of every wall the rectangle touches. */
export function segmentsInRect(
  segments: readonly WallSegment[],
  rect: SelectionRect
): Set<string> {
  const hit = new Set<string>();
  for (const seg of segments) {
    if (segmentIntersectsRect(seg, rect)) hit.add(seg.id);
  }
  return hit;
}
