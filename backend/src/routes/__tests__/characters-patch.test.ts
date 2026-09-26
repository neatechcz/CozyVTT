/**
 * Character PATCH / PUT route tests
 * Runs the real characters router against an in-memory fake Prisma client and
 * a mocked WebSocket broadcaster — no database required.
 */

jest.mock('../../config/database', () => ({
  prisma: {
    character: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    campaignMembership: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
  },
}));

jest.mock('../../websocket/utils', () => ({
  broadcastToCampaign: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import characterRoutes from '../characters';
import { prisma } from '../../config/database';
import { broadcastToCampaign } from '../../websocket/utils';
import { GameSystem } from '../../game-systems';
import { getBlankCharacterTemplate } from '../../validators/game-systems';

type Row = {
  id: string;
  userId: string;
  campaignId: string | null;
  gameSystem: string | null;
  name: string;
  tokenImageUrl: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

const db = prisma as unknown as {
  character: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  campaignMembership: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
};
const broadcast = broadcastToCampaign as jest.Mock;

const OWNER = 'user-owner';
const DM = 'user-dm';
const PLAYER = 'user-player';
const STRANGER = 'user-stranger';

let rows: Map<string, Row>;
let clock: number;
let memberships: Record<string, string>;
let displayNames: Record<string, string>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, v) =>
    (key === 'updatedAt' || key === 'createdAt') && typeof v === 'string' ? new Date(v) : v
  );
}

function withCampaign(row: Row) {
  return {
    ...clone(row),
    campaign: row.campaignId ? { id: row.campaignId, name: 'Klenba' } : null,
  };
}

function nextTime(): Date {
  clock += 1000;
  return new Date(clock);
}

function seed(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: 'char-1',
    userId: OWNER,
    campaignId: 'camp-1',
    gameSystem: GameSystem.DND_5E,
    name: 'Robin',
    tokenImageUrl: null,
    data: getBlankCharacterTemplate(GameSystem.DND_5E) as unknown as Record<string, unknown>,
    createdAt: new Date(0),
    updatedAt: nextTime(),
    ...overrides,
  };
  rows.set(row.id, row);
  return row;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header('x-test-user');
    (req as any).session = userId ? { userId } : {};
    next();
  });
  app.use('/api/characters', characterRoutes);
  return app;
}

const app = buildApp();

beforeEach(() => {
  jest.clearAllMocks();
  rows = new Map();
  clock = Date.parse('2026-09-26T10:00:00.000Z');
  memberships = { [DM]: 'DM', [PLAYER]: 'PLAYER' };
  displayNames = { [OWNER]: 'Václav', [DM]: 'Codex DM', [PLAYER]: 'Player One' };

  db.character.findUnique.mockImplementation(async ({ where, include }: any) => {
    const row = rows.get(where.id);
    if (!row) return null;
    return include?.campaign ? withCampaign(row) : clone(row);
  });
  db.character.updateMany.mockImplementation(async ({ where, data }: any) => {
    const row = rows.get(where.id);
    if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
    rows.set(row.id, { ...row, ...clone(data), updatedAt: nextTime() });
    return { count: 1 };
  });
  db.character.update.mockImplementation(async ({ where, data }: any) => {
    const row = rows.get(where.id)!;
    const updated = { ...row, ...clone(data), updatedAt: nextTime() };
    rows.set(row.id, updated);
    return withCampaign(updated);
  });
  db.campaignMembership.findUnique.mockImplementation(async ({ where }: any) => {
    const { userId, campaignId } = where.userId_campaignId;
    const role = campaignId === 'camp-1' ? memberships[userId] : undefined;
    return role ? { userId, campaignId, role, characterIds: [] } : null;
  });
  db.user.findUnique.mockImplementation(async ({ where }: any) =>
    displayNames[where.id] ? { displayName: displayNames[where.id] } : null
  );
});

function patch(userId: string | null, body: unknown, id = 'char-1') {
  const req = request(app).patch(`/api/characters/${id}/data`);
  if (userId) req.set('x-test-user', userId);
  return req.send(body as object);
}

describe('PATCH /api/characters/:id/data', () => {
  test('200 applies changes, persists them and broadcasts changedPaths + updatedBy', async () => {
    seed();

    const res = await patch(OWNER, {
      changes: [
        { path: 'hp.current', base: 10, value: 4 },
        { path: 'inventory', base: [], value: [{ name: 'Rope', quantity: 1 }] },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(['hp.current', 'inventory']);
    expect(res.body.conflicts).toEqual([]);
    expect(res.body.character.data.hp.current).toBe(4);
    expect(res.body.character.campaign).toEqual({ id: 'camp-1', name: 'Klenba' });
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 4, temporary: 0 });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const [campaignId, event, payload] = broadcast.mock.calls[0];
    expect(campaignId).toBe('camp-1');
    expect(event).toBe('character.updated');
    expect(payload).toEqual({
      characterId: 'char-1',
      character: expect.objectContaining({ id: 'char-1' }),
      userId: OWNER,
      changedPaths: ['hp.current', 'inventory'],
      updatedBy: { userId: OWNER, displayName: 'Václav' },
    });
    expect(payload.character.data.hp.current).toBe(4);
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: OWNER },
      select: { displayName: true },
    });
  });

  test('200 with partial conflicts: applies the rest and reports the conflict', async () => {
    seed();

    const res = await patch(DM, {
      changes: [
        { path: 'hp.current', base: 7, value: 3 },
        { path: 'hp.temporary', base: 0, value: 5 },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(['hp.temporary']);
    expect(res.body.conflicts).toEqual([
      { path: 'hp.current', base: 7, current: 10, attempted: 3 },
    ]);
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 10, temporary: 5 });
    expect(broadcast.mock.calls[0][2]).toMatchObject({
      changedPaths: ['hp.temporary'],
      updatedBy: { userId: DM, displayName: 'Codex DM' },
    });
  });

  test('409 with the same body when every change conflicts; nothing written or broadcast', async () => {
    const before = seed();

    const res = await patch(OWNER, {
      changes: [{ path: 'hp.current', base: 7, value: 3 }],
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      character: expect.objectContaining({ id: 'char-1' }),
      applied: [],
      conflicts: [{ path: 'hp.current', base: 7, current: 10, attempted: 3 }],
    });
    expect(db.character.updateMany).not.toHaveBeenCalled();
    expect(rows.get('char-1')!.updatedAt).toEqual(before.updatedAt);
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('200 for an idempotent retry (current already equals value)', async () => {
    seed();

    const res = await patch(OWNER, {
      changes: [{ path: 'hp.current', base: 3, value: 10 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(['hp.current']);
    expect(res.body.conflicts).toEqual([]);
    expect(db.character.updateMany).not.toHaveBeenCalled();
  });

  test('400 with validationErrors when the merged data fails the schema; nothing written', async () => {
    seed();

    const res = await patch(OWNER, {
      changes: [{ path: 'hp.current', base: 10, value: 'lots' }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation Error');
    expect(res.body.message).toBe('Character data does not match game system schema');
    expect(res.body.validationErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'hp.current' })])
    );
    expect(db.character.updateMany).not.toHaveBeenCalled();
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 10, temporary: 0 });
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('400 for forbidden or malformed paths', async () => {
    seed();

    for (const path of ['__proto__.polluted', 'constructor', 'skills.sleight-of-hand', '', 'a..b']) {
      const res = await patch(OWNER, { changes: [{ path, base: undefined, value: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation Error');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(db.character.updateMany).not.toHaveBeenCalled();
  });

  test('400 for a malformed body or more than 200 changes', async () => {
    seed();

    expect((await patch(OWNER, {})).status).toBe(400);
    expect((await patch(OWNER, { changes: 'hp' })).status).toBe(400);
    expect((await patch(OWNER, { changes: [{ base: 1, value: 2 }] })).status).toBe(400);

    const tooMany = Array.from({ length: 201 }, (_, i) => ({ path: `k${i}`, base: null, value: i }));
    const res = await patch(OWNER, { changes: tooMany });
    expect(res.status).toBe(400);
    expect(db.character.updateMany).not.toHaveBeenCalled();
  });

  test('403 for a campaign player who does not own the character', async () => {
    seed();

    const res = await patch(PLAYER, { changes: [{ path: 'hp.current', base: 10, value: 1 }] });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'Forbidden',
      message: 'You do not have permission to edit this character',
    });
    expect(db.character.updateMany).not.toHaveBeenCalled();
  });

  test('403 for a non-member', async () => {
    seed();
    const res = await patch(STRANGER, { changes: [{ path: 'hp.current', base: 10, value: 1 }] });
    expect(res.status).toBe(403);
  });

  test('404 for an unknown character, 401 without a session', async () => {
    expect((await patch(OWNER, { changes: [] }, 'nope')).status).toBe(404);
    expect((await patch(null, { changes: [] })).status).toBe(401);
  });

  test('retries on a concurrent write and keeps the other writer\'s change', async () => {
    seed();
    const realUpdateMany = db.character.updateMany.getMockImplementation()!;
    // Simulate another writer landing between our read and our first write.
    db.character.updateMany.mockImplementationOnce(async (args: any) => {
      const row = rows.get('char-1')!;
      rows.set('char-1', {
        ...row,
        data: { ...row.data, hp: { ...(row.data.hp as object), maximum: 12 } },
        updatedAt: nextTime(),
      });
      return realUpdateMany(args);
    });

    const res = await patch(OWNER, { changes: [{ path: 'hp.current', base: 10, value: 6 }] });

    expect(res.status).toBe(200);
    expect(db.character.updateMany).toHaveBeenCalledTimes(2);
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 12, current: 6, temporary: 0 });
  });

  test('uses "Unknown" when the updating user has no display name record', async () => {
    seed();
    delete displayNames[OWNER];

    await patch(OWNER, { changes: [{ path: 'hp.current', base: 10, value: 9 }] });

    expect(broadcast.mock.calls[0][2].updatedBy).toEqual({ userId: OWNER, displayName: 'Unknown' });
  });

  test('does not broadcast for a character outside any campaign', async () => {
    seed({ campaignId: null });

    const res = await patch(OWNER, { changes: [{ path: 'hp.current', base: 10, value: 9 }] });

    expect(res.status).toBe(200);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('PUT /api/characters/:id', () => {
  function put(userId: string, body: unknown) {
    return request(app).put('/api/characters/char-1').set('x-test-user', userId).send(body as object);
  }

  test('broadcast carries changedPaths (diff of old and new data) and updatedBy', async () => {
    const row = seed();
    const data = clone(row.data) as any;
    data.hp.current = 2;
    data.inventory = [{ name: 'Torch', quantity: 1 }];

    const res = await put(DM, { data });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Character updated successfully');
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [campaignId, event, payload] = broadcast.mock.calls[0];
    expect(campaignId).toBe('camp-1');
    expect(event).toBe('character.updated');
    expect(payload).toEqual({
      characterId: 'char-1',
      character: expect.objectContaining({ id: 'char-1' }),
      userId: DM,
      changedPaths: expect.any(Array),
      updatedBy: { userId: DM, displayName: 'Codex DM' },
    });
    expect([...payload.changedPaths].sort()).toEqual(['hp.current', 'inventory']);
  });

  test('a name-only update broadcasts empty changedPaths', async () => {
    seed();

    const res = await put(OWNER, { name: 'Robin Hood' });

    expect(res.status).toBe(200);
    expect(broadcast.mock.calls[0][2]).toMatchObject({
      changedPaths: [],
      updatedBy: { userId: OWNER, displayName: 'Václav' },
    });
  });

  test('permissions are unchanged: player 403, DM and owner allowed', async () => {
    seed();
    expect((await put(PLAYER, { name: 'X' })).status).toBe(403);
    expect((await put(STRANGER, { name: 'X' })).status).toBe(403);
    expect((await put(DM, { name: 'X' })).status).toBe(200);
    expect((await put(OWNER, { name: 'Y' })).status).toBe(200);
  });

  test('400 validationErrors shape is unchanged', async () => {
    const row = seed();
    const data = clone(row.data) as any;
    data.hp.current = 'lots';

    const res = await put(OWNER, { data });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Character data does not match game system schema');
    expect(res.body.validationErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'hp.current' })])
    );
  });
});
