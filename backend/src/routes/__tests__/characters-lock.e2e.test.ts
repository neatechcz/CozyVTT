/**
 * Character row lock — end-to-end against real PostgreSQL
 *
 * Every writer of Character.data (PUT /api/characters/:id,
 * PATCH /api/characters/:id/data, the `character.hp.update` socket handler)
 * takes `SELECT … FOR UPDATE` on the character row (services/characterLock).
 * The unit tests run those writers against a fake Prisma client; this suite
 * runs them against the real database and real Socket.IO clients to prove:
 * - no lost update between concurrent writers,
 * - compare-and-set conflicts (409, atomic, non-atomic) on real rows,
 * - a writer really waits for a lock held elsewhere and then sees its commit,
 * - the delegated-control permission rules are re-evaluated under the lock,
 * - `character.updated` reaches only owner, campaign DMs and assigned player.
 *
 * Requires PostgreSQL at DATABASE_URL (same as the other *.e2e suites).
 */

import { randomUUID } from 'crypto';
import request from 'supertest';
import { Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../../config/database';
import {
  createWsTestServer,
  expectNoEvent,
  waitForEvent,
  WsTestServer,
} from '../../__tests__/helpers/websocket-test-server';

jest.setTimeout(30000);

const runId = randomUUID().slice(0, 8);
const email = (name: string) => `lock-${name}-${runId}@test.cozyvtt.local`;

const ability = { score: 10, modifier: 0 };
function baseData(): Record<string, unknown> {
  return {
    characterName: 'Lock Hero',
    class: 'Fighter',
    level: 1,
    race: 'Human',
    proficiencyBonus: 2,
    stats: {
      strength: ability,
      dexterity: ability,
      constitution: ability,
      intelligence: ability,
      wisdom: ability,
      charisma: ability,
    },
    hp: { current: 10, maximum: 10, temporary: 0 },
    backstory: 'original',
    treasure: 'none',
  };
}

let server: WsTestServer;
let ownerId: string;
let dmId: string;
let playerId: string;
let otherPlayerId: string;
let campaignId: string;
let characterId: string;
let ownerCookie: string;
let dmCookie: string;
let playerCookie: string;
let otherCookie: string;
const sockets: ClientSocket[] = [];

type Row = { data: Record<string, any>; updatedAt: Date };
async function readCharacter(): Promise<Row> {
  const row = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
  return { data: row.data as Record<string, any>, updatedAt: row.updatedAt };
}

function patch(cookie: string, body: unknown) {
  // .then() sends the request immediately and gives a real Promise
  return request(server.httpServer)
    .patch(`/api/characters/${characterId}/data`)
    .set('Cookie', cookie)
    .send(body as object)
    .then((res) => res);
}

function put(cookie: string, body: unknown) {
  return request(server.httpServer)
    .put(`/api/characters/${characterId}`)
    .set('Cookie', cookie)
    .send(body as object)
    .then((res) => res);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the character row lock in a separate transaction, run `whileHeld`
 * inside it (after the lock is taken), keep holding for `holdMs`, then commit.
 * Returns once the lock is held (`locked`) and when committed (`done`).
 */
function holdRowLock(holdMs: number, whileHeld: (tx: any) => Promise<void> = async () => undefined) {
  let signalLocked!: () => void;
  const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
  const done = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Character" WHERE "id" = ${characterId} FOR UPDATE`;
    signalLocked();
    await whileHeld(tx);
    await sleep(holdMs);
  }, { maxWait: 5000, timeout: 15000 });
  return { locked, done };
}

async function assignPlayer(assigned: boolean) {
  await prisma.campaignMembership.update({
    where: { userId_campaignId: { userId: playerId, campaignId } },
    data: { characterIds: assigned ? [characterId] : [] },
  });
}

async function connect(cookie: string): Promise<ClientSocket> {
  const socket = await server.connectAndAuth(cookie, campaignId);
  sockets.push(socket);
  return socket;
}

beforeAll(async () => {
  const [owner, dm, player, other] = await Promise.all(
    ['owner', 'dm', 'player', 'other'].map((name) =>
      prisma.user.create({
        data: { email: email(name), passwordHash: 'not-used', displayName: `Lock ${name}` },
      })
    )
  );
  ownerId = owner.id;
  dmId = dm.id;
  playerId = player.id;
  otherPlayerId = other.id;

  const campaign = await prisma.campaign.create({
    data: { name: `Lock Campaign ${runId}`, ownerId: dmId, gameSystem: 'DND_5E', vibeSettings: {} },
  });
  campaignId = campaign.id;

  // The character belongs to a PLAYER owner (not the DM) so owner, DM and
  // assigned player are three distinct recipients
  const character = await prisma.character.create({
    data: { userId: ownerId, campaignId, name: 'Lock Hero', gameSystem: 'DND_5E', data: baseData() as any },
  });
  characterId = character.id;

  await prisma.campaignMembership.createMany({
    data: [
      { userId: dmId, campaignId, role: 'DM', characterIds: [characterId] },
      { userId: ownerId, campaignId, role: 'PLAYER', characterIds: [characterId] },
      { userId: playerId, campaignId, role: 'PLAYER', characterIds: [characterId] },
      { userId: otherPlayerId, campaignId, role: 'PLAYER', characterIds: [] },
    ],
  });

  server = await createWsTestServer();
  [ownerCookie, dmCookie, playerCookie, otherCookie] = await Promise.all([
    server.loginAs(ownerId),
    server.loginAs(dmId),
    server.loginAs(playerId),
    server.loginAs(otherPlayerId),
  ]);
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await server?.close();
  // Let the server's disconnect handlers post their "has left" system
  // messages before the campaign they reference is deleted
  await sleep(300);
  await prisma.campaign.deleteMany({ where: { id: campaignId } });
  await prisma.character.deleteMany({ where: { id: characterId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, dmId, playerId, otherPlayerId] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.character.update({ where: { id: characterId }, data: { data: baseData() as any } });
  await assignPlayer(true);
});

afterEach(() => {
  while (sockets.length) sockets.pop()!.disconnect();
});

describe('PATCH /api/characters/:id/data on a real row', () => {
  it('applies a change, persists it and broadcasts only to owner, DMs and the assigned player', async () => {
    const [ownerSock, dmSock, playerSock, otherSock] = await Promise.all(
      [ownerCookie, dmCookie, playerCookie, otherCookie].map(connect)
    );
    const events = [ownerSock, dmSock, playerSock].map((s) =>
      waitForEvent<{ characterId: string; changedPaths: string[]; updatedBy: { userId: string } }>(s, 'character.updated')
    );
    const otherSilence = expectNoEvent(otherSock, 'character.updated');

    const res = await patch(playerCookie, { changes: [{ path: 'backstory', base: 'original', value: 'player wrote' }] });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(['backstory']);
    expect(res.body.conflicts).toEqual([]);
    expect((await readCharacter()).data.backstory).toBe('player wrote');

    for (const event of await Promise.all(events)) {
      expect(event.characterId).toBe(characterId);
      expect(event.changedPaths).toEqual(['backstory']);
      expect(event.updatedBy.userId).toBe(playerId);
    }
    await otherSilence;
  });

  it('refuses an unassigned player (403) and writes nothing', async () => {
    const before = await readCharacter();
    const res = await patch(otherCookie, { changes: [{ path: 'backstory', base: 'original', value: 'intruder' }] });
    expect(res.status).toBe(403);
    expect(await readCharacter()).toEqual(before);
  });

  it('returns 409 with the current value for a stale base and writes nothing', async () => {
    const before = await readCharacter();
    const res = await patch(dmCookie, { changes: [{ path: 'backstory', base: 'stale', value: 'dm wrote' }] });
    expect(res.status).toBe(409);
    expect(res.body.applied).toEqual([]);
    expect(res.body.conflicts).toEqual([
      { path: 'backstory', base: 'stale', current: 'original', attempted: 'dm wrote' },
    ]);
    expect(await readCharacter()).toEqual(before);
  });

  it('atomic: one conflict aborts the whole change set (409, nothing written)', async () => {
    const before = await readCharacter();
    const res = await patch(dmCookie, {
      atomic: true,
      changes: [
        { path: 'treasure', base: 'none', value: 'gold' },
        { path: 'backstory', base: 'stale', value: 'dm wrote' },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.applied).toEqual([]);
    expect(res.body.conflicts.map((c: { path: string }) => c.path)).toEqual(['backstory']);
    expect(await readCharacter()).toEqual(before);
  });

  it('non-atomic: applies the matching change, reports the conflict (200)', async () => {
    const res = await patch(dmCookie, {
      changes: [
        { path: 'treasure', base: 'none', value: 'gold' },
        { path: 'backstory', base: 'stale', value: 'dm wrote' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(['treasure']);
    expect(res.body.conflicts.map((c: { path: string }) => c.path)).toEqual(['backstory']);
    const { data } = await readCharacter();
    expect(data.treasure).toBe('gold');
    expect(data.backstory).toBe('original');
  });

  it('rejects a merge that fails the game-system schema (400, nothing written)', async () => {
    const before = await readCharacter();
    const res = await patch(dmCookie, { changes: [{ path: 'level', base: 1, value: 99 }] });
    expect(res.status).toBe(400);
    expect(res.body.validationErrors).toBeDefined();
    expect(await readCharacter()).toEqual(before);
  });

  it('sees a preceding PUT: a PATCH based on the pre-PUT value conflicts', async () => {
    const putRes = await put(dmCookie, { data: { ...baseData(), backstory: 'put wrote' } });
    expect(putRes.status).toBe(200);
    const res = await patch(playerCookie, { changes: [{ path: 'backstory', base: 'original', value: 'player wrote' }] });
    expect(res.status).toBe(409);
    expect(res.body.conflicts[0].current).toBe('put wrote');
    expect((await readCharacter()).data.backstory).toBe('put wrote');
  });
});

describe('concurrent writers serialise on the row lock', () => {
  it('concurrent PATCHes on different paths all land — no lost update', async () => {
    const paths = Array.from({ length: 8 }, (_, i) => `notes.n${i}`);
    const cookies = [ownerCookie, dmCookie, playerCookie];
    const results = await Promise.all(
      paths.map((path, i) =>
        patch(cookies[i % cookies.length], { changes: [{ path, base: undefined, value: `v${i}` }] })
      )
    );
    for (const res of results) expect(res.status).toBe(200);
    const { data } = await readCharacter();
    expect(data.notes).toEqual(Object.fromEntries(paths.map((p, i) => [p.split('.')[1], `v${i}`])));
    expect(data.backstory).toBe('original');
  });

  it('concurrent PATCHes on the same path from the same base: exactly one wins, the rest get 409', async () => {
    const values = ['a', 'b', 'c', 'd', 'e'];
    const results = await Promise.all(
      values.map((value, i) =>
        patch(i % 2 ? dmCookie : playerCookie, { changes: [{ path: 'backstory', base: 'original', value }] })
      )
    );
    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(values.length - 1);
    const winningValue = winners[0].body.character.data.backstory;
    expect((await readCharacter()).data.backstory).toBe(winningValue);
    for (const loser of losers) {
      expect(loser.body.conflicts[0].current).toBe(winningValue);
    }
  });

  it('a PATCH waits for a lock held elsewhere, then merges onto that commit', async () => {
    const holder = holdRowLock(600, async (tx) => {
      const row = await tx.character.findUniqueOrThrow({ where: { id: characterId } });
      await tx.character.update({
        where: { id: characterId },
        data: { data: { ...(row.data as object), treasure: 'held tx wrote' } },
      });
    });
    await holder.locked;
    const started = Date.now();
    const pending = patch(dmCookie, { changes: [{ path: 'backstory', base: 'original', value: 'patch wrote' }] });
    await holder.done;
    const res = await pending;
    const waited = Date.now() - started;

    expect(res.status).toBe(200);
    expect(waited).toBeGreaterThanOrEqual(400);
    const { data } = await readCharacter();
    expect(data.treasure).toBe('held tx wrote');
    expect(data.backstory).toBe('patch wrote');
  });

  it('PUT and PATCH racing: the outcome matches one serial order', async () => {
    const [putRes, patchRes] = await Promise.all([
      put(dmCookie, { data: { ...baseData(), backstory: 'put wrote' } }),
      patch(playerCookie, { changes: [{ path: 'backstory', base: 'original', value: 'patch wrote' }] }),
    ]);
    expect(putRes.status).toBe(200);
    const { data } = await readCharacter();
    if (patchRes.status === 200) {
      // PATCH first, then PUT replaced the whole document
      expect(data.backstory).toBe('put wrote');
    } else {
      // PUT first, PATCH saw it and conflicted
      expect(patchRes.status).toBe(409);
      expect(patchRes.body.conflicts[0].current).toBe('put wrote');
      expect(data.backstory).toBe('put wrote');
    }
  });

  it('concurrent HP socket deltas and a PATCH all land', async () => {
    const dmSock = await connect(dmCookie);
    const playerSock = await connect(playerCookie);
    let seen = 0;
    let timer: NodeJS.Timeout | undefined;
    const allHp = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('HP updates not all received')), 8000);
      dmSock.on('character.hp.updated', () => {
        seen += 1;
        if (seen === 4) resolve();
      });
    }).finally(() => clearTimeout(timer));

    dmSock.emit('character.hp.update', { characterId, delta: -1 });
    playerSock.emit('character.hp.update', { characterId, delta: -2 });
    dmSock.emit('character.hp.update', { characterId, delta: -3 });
    const patchRes = patch(playerCookie, { changes: [{ path: 'backstory', base: 'original', value: 'patch wrote' }] });
    playerSock.emit('character.hp.update', { characterId, delta: 1 });

    expect((await patchRes).status).toBe(200);
    await allHp;
    const { data } = await readCharacter();
    expect(data.hp.current).toBe(10 - 1 - 2 - 3 + 1);
    expect(data.backstory).toBe('patch wrote');
  });

  it('an HP delta waits for a held lock and applies to the committed value', async () => {
    const dmSock = await connect(dmCookie);
    const holder = holdRowLock(500, async (tx) => {
      const row = await tx.character.findUniqueOrThrow({ where: { id: characterId } });
      const data = row.data as Record<string, any>;
      await tx.character.update({
        where: { id: characterId },
        data: { data: { ...data, hp: { ...data.hp, current: 5 } } },
      });
    });
    await holder.locked;
    const updated = waitForEvent<{ hp: { current: number } }>(dmSock, 'character.hp.updated', 5000);
    dmSock.emit('character.hp.update', { characterId, delta: -1 });
    await holder.done;
    expect((await updated).hp.current).toBe(4);
    expect((await readCharacter()).data.hp.current).toBe(4);
  });
});

describe('delegated-control permission is re-checked under the row lock', () => {
  it('PATCH: assignment revoked while the request waits for the lock → 403, nothing written', async () => {
    const holder = holdRowLock(400, async (tx) => {
      await tx.campaignMembership.update({
        where: { userId_campaignId: { userId: playerId, campaignId } },
        data: { characterIds: [] },
      });
    });
    await holder.locked;
    const pending = patch(playerCookie, { changes: [{ path: 'backstory', base: 'original', value: 'too late' }] });
    await holder.done;
    const res = await pending;
    expect(res.status).toBe(403);
    expect((await readCharacter()).data.backstory).toBe('original');
  });

  it('PUT: assignment revoked while the request waits for the lock → 403, nothing written', async () => {
    const holder = holdRowLock(400, async (tx) => {
      await tx.campaignMembership.update({
        where: { userId_campaignId: { userId: playerId, campaignId } },
        data: { characterIds: [] },
      });
    });
    await holder.locked;
    const pending = put(playerCookie, { data: { ...baseData(), backstory: 'too late' } });
    await holder.done;
    const res = await pending;
    expect(res.status).toBe(403);
    expect((await readCharacter()).data.backstory).toBe('original');
  });

  it('HP socket: assignment revoked while the update waits for the lock → permission error, nothing written', async () => {
    const playerSock = await connect(playerCookie);
    const holder = holdRowLock(400, async (tx) => {
      await tx.campaignMembership.update({
        where: { userId_campaignId: { userId: playerId, campaignId } },
        data: { characterIds: [] },
      });
    });
    await holder.locked;
    const denial = waitForEvent<{ message: string }>(playerSock, 'error', 5000);
    playerSock.emit('character.hp.update', { characterId, delta: -4 });
    await holder.done;
    expect((await denial).message).toMatch(/permission/);
    expect((await readCharacter()).data.hp.current).toBe(10);
  });
});
