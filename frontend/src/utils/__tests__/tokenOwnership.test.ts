/**
 * The client's "own token" rule for dynamic lighting (vision sources, fog
 * exemption) — the same rule as the server's isOwnToken: controlled by the
 * user, or linked to a character the user owns or is assigned through their
 * campaign membership `characterIds`.
 */

import { describe, it, expect } from 'vitest';
import { getOwnCharacterIds, isOwnToken } from '../tokenOwnership';

const campaign = {
  characters: [
    { id: 'char-owned', userId: 'alice' },
    { id: 'char-robin', userId: 'mcp-service' },
    { id: 'char-other', userId: 'mcp-service' },
  ],
  memberships: [
    { userId: 'alice', role: 'PLAYER', characterIds: ['char-robin'] },
    { userId: 'bob', role: 'PLAYER', characterIds: ['char-other'] },
  ],
};

describe('getOwnCharacterIds', () => {
  it('collects owned and assigned characters', () => {
    expect([...getOwnCharacterIds(campaign, 'alice')].sort()).toEqual(['char-owned', 'char-robin']);
  });

  it('is empty without a user or campaign', () => {
    expect(getOwnCharacterIds(campaign, undefined).size).toBe(0);
    expect(getOwnCharacterIds(null, 'alice').size).toBe(0);
  });
});

describe('isOwnToken', () => {
  const own = getOwnCharacterIds(campaign, 'alice');

  it('counts a controlled token', () => {
    expect(isOwnToken({ controlledBy: 'alice', characterId: null }, 'alice', own)).toBe(true);
  });

  it('counts an assigned character token with no controller (MCP-created PC)', () => {
    expect(isOwnToken({ controlledBy: null, characterId: 'char-robin' }, 'alice', own)).toBe(true);
  });

  it('counts an owned character token', () => {
    expect(isOwnToken({ controlledBy: null, characterId: 'char-owned' }, 'alice', own)).toBe(true);
  });

  it('does not count another player\'s character or an NPC', () => {
    expect(isOwnToken({ controlledBy: null, characterId: 'char-other' }, 'alice', own)).toBe(false);
    expect(isOwnToken({ controlledBy: 'bob', characterId: null }, 'alice', own)).toBe(false);
    expect(isOwnToken({ controlledBy: null, characterId: null }, undefined, own)).toBe(false);
  });
});
