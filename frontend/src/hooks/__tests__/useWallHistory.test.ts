import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { WallSegment } from '@/types/walls';
import { useWallHistory } from '../useWallHistory';

const seg = (id: string): WallSegment => ({ id, x1: 0, y1: 0, x2: 100, y2: 0, type: 'wall' });

describe('useWallHistory', () => {
  it('starts with the initial walls and no undo/redo', () => {
    const { result } = renderHook(() => useWallHistory([seg('a')]));

    expect(result.current.walls).toEqual([seg('a')]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('reset replaces the walls and drops undo history', () => {
    const { result } = renderHook(() => useWallHistory([seg('a')]));

    act(() => result.current.push([seg('a'), seg('b')]));
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.reset([seg('c')]));

    expect(result.current.walls).toEqual([seg('c')]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('reset drops redo history too', () => {
    const { result } = renderHook(() => useWallHistory([seg('a')]));

    act(() => result.current.push([seg('a'), seg('b')]));
    act(() => result.current.push([seg('a'), seg('b'), seg('c')]));
    act(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.reset([seg('z')]));

    expect(result.current.walls).toEqual([seg('z')]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('undo after a reset returns null (reset starts a fresh single-entry stack)', () => {
    const { result } = renderHook(() => useWallHistory([seg('a')]));

    act(() => result.current.push([seg('a'), seg('b')]));
    act(() => result.current.reset([seg('z')]));

    let undone: WallSegment[] | null = [];
    act(() => { undone = result.current.undo(); });

    expect(undone).toBeNull();
    expect(result.current.walls).toEqual([seg('z')]);
  });

  // reset/replace also accept an updater `(current) => next`, resolved inside
  // the same setWs(prev => ...) functional update React uses to compose
  // multiple state updates queued in the same tick. A caller (the wall socket
  // hook) that fires several `reset`/`replace` calls back to back — e.g. three
  // broadcasts delivered in the same macrotask, before React re-renders and a
  // ref-based "current walls" snapshot could catch up — must have each call
  // see the previous call's result, not a stale render-time value.
  it('reset composes consecutive updater calls made before a re-render', () => {
    const { result } = renderHook(() => useWallHistory([seg('h'), seg('w')]));

    act(() => {
      // Simulates: remote wall:removed('h') + wall:added('a') + wall:added('b')
      result.current.reset((current: WallSegment[]) => current.filter((s) => s.id !== 'h'));
      result.current.reset((current: WallSegment[]) => [...current, seg('a')]);
      result.current.reset((current: WallSegment[]) => [...current, seg('b')]);
    });

    expect(result.current.walls.map((s) => s.id)).toEqual(['w', 'a', 'b']);
  });

  it('replace composes consecutive updater calls made before a re-render', () => {
    const { result } = renderHook(() => useWallHistory([seg('a')]));

    act(() => {
      result.current.replace((current: WallSegment[]) => [...current, seg('b')]);
      result.current.replace((current: WallSegment[]) => [...current, seg('c')]);
    });

    expect(result.current.walls.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('reset still accepts a plain array (existing callers unaffected)', () => {
    const { result } = renderHook(() => useWallHistory([seg('a')]));

    act(() => result.current.reset([seg('z')]));

    expect(result.current.walls).toEqual([seg('z')]);
  });
});
