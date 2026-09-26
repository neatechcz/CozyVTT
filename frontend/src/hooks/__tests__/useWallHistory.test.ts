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
});
