/**
 * Character PATCH / PUT route tests
 * Runs the real characters router against an in-memory fake Prisma client and
 * a mocked WebSocket broadcaster — no database required.
 */

jest.mock('../../config/database', () => {
  const prisma: any = {
    $queryRaw: jest.fn(),
    character: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    campaignMembership: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  // Interactive transaction: the callback gets the same fake client as `tx`.
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  return { prisma };
});

jest.mock('../../websocket/utils', () => ({
  broadcastToCampaign: jest.fn(),
  broadcastToCharacterViewers: jest.fn(async () => undefined),
}));

import { Prisma } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import characterRoutes, { characterDataPatchBodyParser } from '../characters';
import { prisma } from '../../config/database';
import { broadcastToCharacterViewers } from '../../websocket/utils';
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
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
  character: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  campaignMembership: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
};
/** character.updated goes to the sheet's viewers (owner, DMs, assigned player), not the campaign room */
const broadcast = broadcastToCharacterViewers as jest.Mock;

const OWNER = 'user-owner';
const DM = 'user-dm';
const PLAYER = 'user-player';
const STRANGER = 'user-stranger';
/** a campaign PLAYER the character is assigned to (delegated character control) */
const ASSIGNED = 'user-assigned';

let rows: Map<string, Row>;
let clock: number;
let memberships: Record<string, string>;
let assignments: Record<string, string[]>;
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
  // Same body-parser order as server.ts
  app.patch('/api/characters/:id/data', characterDataPatchBodyParser);
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
  memberships = { [DM]: 'DM', [PLAYER]: 'PLAYER', [ASSIGNED]: 'PLAYER' };
  assignments = { [ASSIGNED]: ['char-1'] };
  displayNames = { [OWNER]: 'Václav', [DM]: 'Codex DM', [PLAYER]: 'Player One' };

  // Row lock: no-op by default; tests override it to simulate a writer that
  // commits while we wait for the lock.
  db.$queryRaw.mockResolvedValue([]);
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
    return role ? { userId, campaignId, role, characterIds: [...(assignments[userId] ?? [])] } : null;
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
    const [target, event, payload] = broadcast.mock.calls[0];
    expect(target).toEqual(expect.objectContaining({ id: 'char-1', campaignId: 'camp-1', userId: OWNER }));
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

  test('atomic: one conflict → 409, nothing written or broadcast', async () => {
    const before = seed();

    const res = await patch(OWNER, {
      atomic: true,
      changes: [
        { path: 'hp.temporary', base: 0, value: 5 },
        { path: 'hp.current', base: 7, value: 3 },
      ],
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      character: expect.objectContaining({ id: 'char-1' }),
      applied: [],
      conflicts: [{ path: 'hp.current', base: 7, current: 10, attempted: 3 }],
    });
    expect(db.character.updateMany).not.toHaveBeenCalled();
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 10, temporary: 0 });
    expect(rows.get('char-1')!.updatedAt).toEqual(before.updatedAt);
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('atomic: no conflict → 200, all applied and broadcast', async () => {
    seed();

    const res = await patch(OWNER, {
      atomic: true,
      changes: [
        { path: 'hp.temporary', base: 0, value: 5 },
        { path: 'hp.current', base: 10, value: 3 },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(['hp.temporary', 'hp.current']);
    expect(res.body.conflicts).toEqual([]);
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 3, temporary: 5 });
    expect(broadcast.mock.calls[0][2].changedPaths).toEqual(['hp.temporary', 'hp.current']);
  });

  test('400 when atomic is not a boolean', async () => {
    seed();
    const res = await patch(OWNER, { atomic: 'yes', changes: [] });
    expect(res.status).toBe(400);
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

  test('locks the row and reads under the lock: a change committed while waiting is kept', async () => {
    seed();
    // Another writer commits hp.maximum while this request waits for the lock.
    db.$queryRaw.mockImplementationOnce(async () => {
      const row = rows.get('char-1')!;
      rows.set('char-1', {
        ...row,
        data: { ...row.data, hp: { ...(row.data.hp as object), maximum: 12 } },
        updatedAt: nextTime(),
      });
      return [];
    });

    const res = await patch(OWNER, { changes: [{ path: 'hp.current', base: 10, value: 6 }] });

    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.character.updateMany.mock.invocationCallOrder[0]
    );
    expect(db.character.updateMany).toHaveBeenCalledTimes(1);
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 12, current: 6, temporary: 0 });
  });

  test('a path through an array or null is a 409 conflict showing the blocking value', async () => {
    seed({
      data: {
        ...(getBlankCharacterTemplate(GameSystem.DND_5E) as unknown as Record<string, unknown>),
        inventory: [{ name: 'Rope', quantity: 1 }],
        spellcasting: null,
      },
    });

    const res = await patch(OWNER, {
      changes: [
        { path: 'inventory.0', value: { name: 'Torch', quantity: 1 } },
        { path: 'spellcasting.ability', value: 'INT' },
      ],
    });

    expect(res.status).toBe(409);
    expect(res.body.applied).toEqual([]);
    expect(res.body.conflicts).toEqual([
      { path: 'inventory.0', current: [{ name: 'Rope', quantity: 1 }], attempted: { name: 'Torch', quantity: 1 } },
      { path: 'spellcasting.ability', current: null, attempted: 'INT' },
    ]);
    expect(db.character.updateMany).not.toHaveBeenCalled();
  });

  test('accepts a ~200 kB body (1mb limit on this route only)', async () => {
    const row = seed();
    const backstory = 'x'.repeat(200 * 1024);

    const res = await patch(OWNER, {
      changes: [{ path: 'backstory', base: row.data.backstory, value: backstory }],
    });

    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(['backstory']);
    expect(rows.get('char-1')!.data.backstory).toHaveLength(200 * 1024);
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
    const [target, event, payload] = broadcast.mock.calls[0];
    expect(target).toEqual(expect.objectContaining({ id: 'char-1', campaignId: 'camp-1', userId: OWNER }));
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

  test('diffs against the row read under the lock, not the earlier unlocked read', async () => {
    const row = seed();
    const data = clone(row.data) as any; // client's copy: temporary 0
    data.hp.current = 2;
    // Another writer commits hp.temporary while this PUT waits for the lock;
    // the whole-document PUT reverts it, so it must appear in changedPaths.
    db.$queryRaw.mockImplementationOnce(async () => {
      const current = rows.get('char-1')!;
      rows.set('char-1', {
        ...current,
        data: { ...current.data, hp: { ...(current.data.hp as object), temporary: 4 } },
        updatedAt: nextTime(),
      });
      return [];
    });

    const res = await put(OWNER, { data });

    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.character.update.mock.invocationCallOrder[0]
    );
    expect([...broadcast.mock.calls[0][2].changedPaths].sort()).toEqual(['hp.current', 'hp.temporary']);
  });

  test('keeps the global 100kb JSON limit (413 for a ~200 kB PUT)', async () => {
    const row = seed();
    const data = { ...clone(row.data), backstory: 'x'.repeat(200 * 1024) };
    const res = await put(OWNER, { data });
    expect(res.status).toBe(413);
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

  test('permissions: unassigned player 403, DM, owner and assigned player allowed', async () => {
    seed();
    expect((await put(ASSIGNED, { name: 'Z' })).status).toBe(200);
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

describe('row lock busy (Prisma transaction timeout P2028)', () => {
  const lockTimeout = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Transaction API error: Transaction already closed: the timeout for this transaction was 10000 ms.',
      { code: 'P2028', clientVersion: 'test' }
    );
  const BUSY = { error: 'Service Unavailable', message: 'Character is busy, retry shortly' };

  test('PATCH answers 503 "Character is busy", nothing written or broadcast', async () => {
    seed();
    db.$transaction.mockRejectedValueOnce(lockTimeout());

    const res = await patch(OWNER, { changes: [{ path: 'hp.current', base: 10, value: 4 }] });

    expect(res.status).toBe(503);
    expect(res.body).toEqual(BUSY);
    expect(res.headers['retry-after']).toBe('1');
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 10, temporary: 0 });
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('PUT answers 503 "Character is busy", nothing broadcast', async () => {
    seed();
    db.$transaction.mockRejectedValueOnce(lockTimeout());

    const res = await request(app).put('/api/characters/char-1').set('x-test-user', OWNER).send({ name: 'X' });

    expect(res.status).toBe(503);
    expect(res.body).toEqual(BUSY);
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('other transaction errors stay 500', async () => {
    seed();
    db.$transaction.mockRejectedValueOnce(new Error('connection reset'));

    const res = await patch(OWNER, { changes: [{ path: 'hp.current', base: 10, value: 4 }] });

    expect(res.status).toBe(500);
  });

  test('PATCH and PUT take the row lock with explicit maxWait / timeout', async () => {
    seed();
    await patch(OWNER, { changes: [{ path: 'hp.current', base: 10, value: 4 }] });
    await request(app).put('/api/characters/char-1').set('x-test-user', OWNER).send({ name: 'X' });

    expect(db.$transaction).toHaveBeenCalledTimes(2);
    for (const call of db.$transaction.mock.calls) {
      expect(call[1]).toEqual({ maxWait: 5000, timeout: 10000 });
    }
  });
});

describe('delegated character control (production permission rules inside the row lock)', () => {
  function put(userId: string, body: unknown) {
    return request(app).put('/api/characters/char-1').set('x-test-user', userId).send(body as object);
  }

  /** The DM moves the character away from ASSIGNED while the request waits for the row lock. */
  function unassignWhileWaitingForLock() {
    db.$queryRaw.mockImplementationOnce(async () => {
      assignments[ASSIGNED] = [];
      return [];
    });
  }

  test('PATCH: the assigned player may edit; an unassigned player may not', async () => {
    seed();

    const ok = await patch(ASSIGNED, { changes: [{ path: 'hp.current', base: 10, value: 7 }] });
    expect(ok.status).toBe(200);
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 7, temporary: 0 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    const denied = await patch(PLAYER, { changes: [{ path: 'hp.current', base: 7, value: 1 }] });
    expect(denied.status).toBe(403);
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 7, temporary: 0 });
  });

  test('PATCH: assignment removed while waiting for the lock → 403, nothing written or broadcast', async () => {
    seed();
    unassignWhileWaitingForLock();

    const res = await patch(ASSIGNED, { changes: [{ path: 'hp.current', base: 10, value: 1 }] });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'Forbidden',
      message: 'You do not have permission to edit this character',
    });
    expect(db.character.updateMany).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('PUT: assignment removed while waiting for the lock → 403, nothing written or broadcast', async () => {
    seed();
    unassignWhileWaitingForLock();

    const res = await put(ASSIGNED, { name: 'Hijacked' });

    expect(res.status).toBe(403);
    expect(db.character.update).not.toHaveBeenCalled();
    expect(rows.get('char-1')!.name).toBe('Robin');
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('PUT: the permission re-check reads the membership after taking the lock', async () => {
    seed();

    await put(ASSIGNED, { name: 'Robin II' });

    const lockOrder = db.$queryRaw.mock.invocationCallOrder[0];
    const membershipReads = db.campaignMembership.findUnique.mock.invocationCallOrder;
    expect(membershipReads.some((order) => order > lockOrder)).toBe(true);
    expect(db.character.update.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...membershipReads));
  });
});

describe('PUT /api/characters/:id — expectedUpdatedAt precondition', () => {
  function put(userId: string, body: unknown) {
    return request(app).put('/api/characters/char-1').set('x-test-user', userId).send(body as object);
  }
  const CONFLICT_MESSAGE = 'Character changed since it was loaded';

  test('matches the locked row → 200, written and broadcast', async () => {
    const row = seed();
    const data = clone(row.data) as any;
    data.hp.current = 3;

    const res = await put(OWNER, { data, expectedUpdatedAt: row.updatedAt.toISOString() });

    expect(res.status).toBe(200);
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 3, temporary: 0 });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test('the same instant written with a UTC offset also matches', async () => {
    const row = seed();
    const shifted = new Date(row.updatedAt.getTime() + 2 * 3600 * 1000).toISOString().replace('Z', '+02:00');

    const res = await put(OWNER, { name: 'Robin Hood', expectedUpdatedAt: shifted });

    expect(res.status).toBe(200);
    expect(rows.get('char-1')!.name).toBe('Robin Hood');
  });

  test('differs from the row → 409 with the current character, nothing written or broadcast', async () => {
    const row = seed();
    const stale = new Date(row.updatedAt.getTime() - 1000).toISOString();
    const data = clone(row.data) as any;
    data.hp.current = 3;

    const res = await put(DM, { data, name: 'Overwritten', expectedUpdatedAt: stale });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Conflict',
      message: CONFLICT_MESSAGE,
      character: expect.objectContaining({
        id: 'char-1',
        name: 'Robin',
        updatedAt: row.updatedAt.toISOString(),
        campaign: { id: 'camp-1', name: 'Klenba' },
      }),
    });
    expect(res.body.character.data.hp).toEqual({ maximum: 10, current: 10, temporary: 0 });
    expect(db.character.update).not.toHaveBeenCalled();
    expect(rows.get('char-1')!.name).toBe('Robin');
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('is checked against the row read under the lock: a write committed while waiting → 409', async () => {
    const row = seed();
    const loadedAt = row.updatedAt.toISOString();
    // Another writer commits while this PUT waits for the row lock
    db.$queryRaw.mockImplementationOnce(async () => {
      const current = rows.get('char-1')!;
      rows.set('char-1', {
        ...current,
        data: { ...current.data, backstory: 'patched meanwhile' },
        updatedAt: nextTime(),
      });
      return [];
    });
    const data = clone(row.data) as any;
    data.hp.current = 3;

    const res = await put(OWNER, { data, expectedUpdatedAt: loadedAt });

    expect(res.status).toBe(409);
    expect(res.body.character.data.backstory).toBe('patched meanwhile');
    expect(db.character.update).not.toHaveBeenCalled();
    expect(rows.get('char-1')!.data.backstory).toBe('patched meanwhile');
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 10, temporary: 0 });
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('absent → unchanged behaviour: the whole document is replaced even if the row changed', async () => {
    const row = seed();
    rows.set('char-1', { ...rows.get('char-1')!, updatedAt: nextTime() });
    const data = clone(row.data) as any;
    data.hp.current = 3;

    const res = await put(OWNER, { data });

    expect(res.status).toBe(200);
    expect(rows.get('char-1')!.data.hp).toEqual({ maximum: 10, current: 3, temporary: 0 });
  });

  test('a caller who may not edit gets 403 (no character in the body), not 409', async () => {
    const row = seed();
    const stale = new Date(row.updatedAt.getTime() - 1000).toISOString();

    const res = await put(PLAYER, { name: 'X', expectedUpdatedAt: stale });

    expect(res.status).toBe(403);
    expect(res.body.character).toBeUndefined();
  });

  test('assignment revoked while waiting for the lock + stale expectedUpdatedAt → 403, no character leaked', async () => {
    const row = seed();
    const stale = new Date(row.updatedAt.getTime() - 1000).toISOString();
    db.$queryRaw.mockImplementationOnce(async () => {
      assignments[ASSIGNED] = [];
      return [];
    });

    const res = await put(ASSIGNED, { name: 'X', expectedUpdatedAt: stale });

    expect(res.status).toBe(403);
    expect(res.body.character).toBeUndefined();
  });

  test.each([['not a date'], ['2026-09-26'], [12345], [null]])(
    'an invalid expectedUpdatedAt (%p) → 400, nothing written',
    async (expectedUpdatedAt) => {
      seed();

      const res = await put(OWNER, { name: 'X', expectedUpdatedAt });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation Error');
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(rows.get('char-1')!.name).toBe('Robin');
    }
  );
});
