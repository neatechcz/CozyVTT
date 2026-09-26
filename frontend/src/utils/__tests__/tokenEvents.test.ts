/**
 * Unit tests for the pure token-event reducer that applies the backend's
 * token.added / token.updated / token.removed broadcasts to a token list.
 */

import { describe, it, expect } from 'vitest';
import { applyTokenEvent, type TokenEvent } from '../tokenEvents';
import { TokenLayer, type Token } from '@/types';

function token(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    characterId: null,
    name: `Token ${id}`,
    imageUrl: '',
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 },
    layer: TokenLayer.TOKEN,
    visible: true,
    controlledBy: null,
    rotation: 0,
    conditions: [],
    metadata: {},
    type: 'npc',
    disposition: null,
    hp: null,
    showHpBar: false,
    notes: '',
    initiative: null,
    ...overrides,
  } as Token;
}

describe('applyTokenEvent', () => {
  const a = token('a');
  const b = token('b');

  it('token.added appends a new token', () => {
    const c = token('c');
    const event: TokenEvent = { type: 'token.added', mapId: 'm', token: c };
    expect(applyTokenEvent([a, b], event)).toEqual([a, b, c]);
  });

  it('token.added for a known id replaces it in place (no duplicate)', () => {
    const newA = token('a', { name: 'Renamed' });
    const result = applyTokenEvent([a, b], { type: 'token.added', mapId: 'm', token: newA });
    expect(result).toEqual([newA, b]);
  });

  it('token.updated replaces the token by id, keeping order', () => {
    const newB = token('b', { hp: { current: 1, max: 7, temp: 0 } });
    const result = applyTokenEvent([a, b], { type: 'token.updated', mapId: 'm', token: newB });
    expect(result).toEqual([a, newB]);
  });

  it('token.updated for an unknown id adds it (the client missed the add)', () => {
    const c = token('c');
    expect(applyTokenEvent([a], { type: 'token.updated', mapId: 'm', token: c })).toEqual([a, c]);
  });

  it('token.removed filters the token out', () => {
    expect(applyTokenEvent([a, b], { type: 'token.removed', mapId: 'm', tokenId: 'a' })).toEqual([b]);
  });

  it('token.removed for an unknown id leaves the list unchanged', () => {
    const list = [a, b];
    expect(applyTokenEvent(list, { type: 'token.removed', mapId: 'm', tokenId: 'zzz' })).toEqual(list);
  });

  it('does not mutate the input list', () => {
    const list = [a, b];
    applyTokenEvent(list, { type: 'token.added', mapId: 'm', token: token('c') });
    applyTokenEvent(list, { type: 'token.updated', mapId: 'm', token: token('a', { name: 'x' }) });
    applyTokenEvent(list, { type: 'token.removed', mapId: 'm', tokenId: 'b' });
    expect(list).toEqual([a, b]);
    expect(list[0].name).toBe('Token a');
  });

  it('is mapId-agnostic: filtering events for other maps is the caller\'s job', () => {
    // MapCanvas ignores events whose mapId differs from the displayed map
    // before calling the reducer; the reducer itself applies whatever it gets.
    const c = token('c');
    expect(applyTokenEvent([a], { type: 'token.added', mapId: 'other-map', token: c })).toEqual([a, c]);
  });
});
