/**
 * getOwnCharacterIdsBatch — the `characterIds` of a TokenViewer (isOwnToken).
 *
 * Membership `characterIds` count as a user's own only for PLAYER-role
 * memberships (the same rule as the character-sheet recipients); owning the
 * character (`userId`) counts for anyone.
 *
 * No database: Prisma is mocked with rows that honour the query's filters.
 */

jest.mock('../../config/database', () => ({
  prisma: {
    campaignMembership: { findMany: jest.fn() },
    character: { findMany: jest.fn() },
  },
}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { prisma } from '../../config/database';
import { getOwnCharacterIdsBatch } from '../spirit-layer';

const CAMPAIGN_ID = 'campaign-1';

const db = prisma as unknown as {
  campaignMembership: { findMany: jest.Mock };
  character: { findMany: jest.Mock };
};

const memberships = [
  { campaignId: CAMPAIGN_ID, userId: 'alice', role: 'PLAYER', characterIds: ['char-robin'] },
  { campaignId: CAMPAIGN_ID, userId: 'sam', role: 'SPECTATOR', characterIds: ['char-tomin'] },
  { campaignId: CAMPAIGN_ID, userId: 'dana', role: 'DM', characterIds: ['char-mich'] },
];

const characters = [
  { id: 'char-owned-by-sam', userId: 'sam', campaignId: CAMPAIGN_ID },
  { id: 'char-robin', userId: 'mcp-service', campaignId: CAMPAIGN_ID },
  { id: 'char-tomin', userId: 'mcp-service', campaignId: CAMPAIGN_ID },
];

/** Rows matching a `where` of equality and `{ in }` conditions. */
function matching<T extends Record<string, unknown>>(rows: T[], where: Record<string, unknown>): T[] {
  return rows.filter((row) =>
    Object.entries(where).every(([key, cond]) =>
      cond && typeof cond === 'object' && 'in' in cond
        ? (cond as { in: unknown[] }).in.includes(row[key])
        : row[key] === cond
    )
  );
}

beforeEach(() => {
  db.campaignMembership.findMany.mockImplementation(async ({ where }) => matching(memberships, where));
  db.character.findMany.mockImplementation(async ({ where }) => matching(characters, where));
});

describe('getOwnCharacterIdsBatch', () => {
  it('counts a PLAYER membership\'s assigned characters', async () => {
    const own = await getOwnCharacterIdsBatch(CAMPAIGN_ID, ['alice']);
    expect([...own.get('alice')!]).toEqual(['char-robin']);
  });

  it('does not count a SPECTATOR membership\'s characterIds', async () => {
    const own = await getOwnCharacterIdsBatch(CAMPAIGN_ID, ['sam']);
    expect(own.get('sam')!.has('char-tomin')).toBe(false);
  });

  it('still counts characters a SPECTATOR owns', async () => {
    const own = await getOwnCharacterIdsBatch(CAMPAIGN_ID, ['sam']);
    expect([...own.get('sam')!]).toEqual(['char-owned-by-sam']);
  });

  it('does not count a DM membership\'s characterIds', async () => {
    const own = await getOwnCharacterIdsBatch(CAMPAIGN_ID, ['dana']);
    expect(own.get('dana')!.size).toBe(0);
  });
});
