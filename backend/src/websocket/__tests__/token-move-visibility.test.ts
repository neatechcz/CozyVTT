/**
 * token.move.start / token.move / token.move.end must not leak tokens a
 * player cannot see: hidden tokens (`visible: false`), spirit-layer tokens on
 * a plane the player does not see, DM `notes`, and — on a map with dynamic
 * lighting — tokens outside the player's line of sight. Same per-recipient
 * pipeline as map.changed and the REST token events (filterTokensForViewer).
 * DMs are unaffected.
 *
 * No database: Prisma is mocked; the Socket.io server is a fake whose room
 * broadcasts are delivered to the fake sockets, so every assertion is per
 * socket regardless of whether the handler emitted per socket or to the room.
 *
 * Fixture: 10×10 squares, gridSize 100 px. With lighting on, a solid wall at
 * x = 500 px splits the map into west (columns 0–4) and east (5–9).
 */

jest.mock('../../config/database', () => ({
  prisma: {
    map: { findUnique: jest.fn(), update: jest.fn() },
    campaignMembership: { findMany: jest.fn() },
    campaign: { findUnique: jest.fn() },
    character: { findMany: jest.fn(async () => []) },
  },
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { prisma } from '../../config/database';
import { registerTokenHandlers } from '../handlers/tokens';

const CAMPAIGN_ID = 'campaign-1';
const MAP_ID = 'map-1';

const db = prisma as unknown as {
  map: { findUnique: jest.Mock; update: jest.Mock };
  campaignMembership: { findMany: jest.Mock };
  campaign: { findUnique: jest.Mock };
};

type FakeSocket = {
  id: string;
  userId: string;
  role: string;
  campaignId: string;
  emit: jest.Mock;
  on: jest.Mock;
  to: jest.Mock;
  handlers: Record<string, (payload: unknown) => unknown>;
};

type TestToken = Record<string, unknown> & { id: string };

function token(id: string, x: number, y: number, overrides: Record<string, unknown> = {}): TestToken {
  return {
    id,
    name: id,
    imageUrl: '',
    position: { x, y },
    size: { width: 1, height: 1 },
    layer: 'token',
    visible: true,
    controlledBy: null,
    rotation: 0,
    conditions: [],
    metadata: {},
    ...overrides,
  };
}

const WALL = { id: 'wall-1', x1: 500, y1: 0, x2: 500, y2: 1000, type: 'wall' };

// West of the wall
const aliceToken = token('pc-alice', 2, 5, { controlledBy: 'alice', sightRadius: 0 });
const bobToken = token('pc-bob', 1, 2, { controlledBy: 'bob', sightRadius: 0 });
const lurker = token('lurker', 3, 5, { visible: false, notes: 'DM secret: ambush' });
const orc = token('orc', 3, 6, { notes: 'DM secret: carries the key' });
const wraith = token('wraith', 3, 4, { layer: 'spirit' });
// East of the wall
const goblin = token('goblin', 7, 5, { notes: 'DM secret: coward' });

function mapWith(lightingEnabled: boolean, tokens: TestToken[] = [aliceToken, bobToken, lurker, orc, wraith, goblin]) {
  return {
    id: MAP_ID,
    campaignId: CAMPAIGN_ID,
    width: 10,
    height: 10,
    gridSize: 100,
    tokens: JSON.parse(JSON.stringify(tokens)),
    wallSegments: lightingEnabled ? [WALL] : [],
    lights: [],
    lightingEnabled,
  };
}

let sockets: FakeSocket[];

function makeSocket(id: string, userId: string, role: string): FakeSocket {
  const s: FakeSocket = {
    id,
    userId,
    role,
    campaignId: CAMPAIGN_ID,
    emit: jest.fn(),
    handlers: {},
    on: jest.fn(),
    to: jest.fn(),
  };
  s.on.mockImplementation((event: string, handler: (payload: unknown) => unknown) => {
    s.handlers[event] = handler;
  });
  // socket.to(room).emit — everyone in the room except the sender
  s.to.mockImplementation(() => ({
    emit: (event: string, payload: unknown) => {
      for (const other of sockets) if (other.id !== s.id) other.emit(event, payload);
    },
  }));
  return s;
}

const io = {
  in: jest.fn(() => ({ fetchSockets: jest.fn(async () => sockets) })),
  to: jest.fn(() => ({
    emit: (event: string, payload: unknown) => {
      for (const s of sockets) s.emit(event, payload);
    },
  })),
};

let dm: FakeSocket;
let alice: FakeSocket;
let bob: FakeSocket;

function received(s: FakeSocket) {
  return s.emit.mock.calls.map(([event, payload]) => [event, payload]);
}

function receivedTokenIds(s: FakeSocket): string[] {
  return s.emit.mock.calls.map(([, payload]) => payload?.tokenId ?? payload?.token?.id);
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function useMap(lightingEnabled: boolean) {
  db.map.findUnique.mockResolvedValue(mapWith(lightingEnabled));
}

async function moveEnd(sender: FakeSocket, tokenId: string, x: number, y: number) {
  registerTokenHandlers(io as any, sender as any);
  await sender.handlers['token.move.end']({ tokenId, mapId: MAP_ID, x, y });
}

async function moveStart(sender: FakeSocket, tokenId: string) {
  registerTokenHandlers(io as any, sender as any);
  await sender.handlers['token.move.start']({ tokenId, mapId: MAP_ID });
}

async function moveFrame(sender: FakeSocket, tokenId: string, x: number, y: number) {
  registerTokenHandlers(io as any, sender as any);
  sender.handlers['token.move']({ tokenId, mapId: MAP_ID, x, y });
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  dm = makeSocket('s-dm', 'dm-user', 'DM');
  alice = makeSocket('s-alice', 'alice', 'PLAYER');
  bob = makeSocket('s-bob', 'bob', 'PLAYER');
  sockets = [dm, alice, bob];
  db.map.update.mockResolvedValue({});
  db.campaignMembership.findMany.mockResolvedValue([
    { userId: 'dm-user', role: 'DM' },
    { userId: 'alice', role: 'PLAYER' },
    { userId: 'bob', role: 'PLAYER' },
  ]);
  db.campaign.findUnique.mockResolvedValue({ spiritLayerEnabled: false, currentMapId: MAP_ID });
});

describe('token.move.end without lighting', () => {
  it('sends a visible token\'s move to everyone', async () => {
    useMap(false);
    await moveEnd(alice, 'pc-alice', 2, 6);

    const moved = ['token.moved', { tokenId: 'pc-alice', mapId: MAP_ID, x: 2, y: 6, movedBy: 'alice' }];
    expect(received(dm)).toEqual([moved]);
    expect(received(alice)).toEqual([moved]);
    expect(received(bob)).toEqual([moved]);
  });

  it('sends a hidden token\'s move only to DMs', async () => {
    useMap(false);
    await moveEnd(dm, 'lurker', 4, 4);

    expect(received(dm)).toEqual([['token.moved', { tokenId: 'lurker', mapId: MAP_ID, x: 4, y: 4, movedBy: 'dm-user' }]]);
    expect(alice.emit).not.toHaveBeenCalled();
    expect(bob.emit).not.toHaveBeenCalled();
  });

  it('sends a spirit-layer token\'s move only to DMs when players cannot see the spirit layer', async () => {
    useMap(false);
    await moveEnd(dm, 'wraith', 4, 4);

    expect(receivedTokenIds(dm)).toEqual(['wraith']);
    expect(alice.emit).not.toHaveBeenCalled();
    expect(bob.emit).not.toHaveBeenCalled();
  });
});

describe('token.move.end on a lighting map', () => {
  it('never sends hidden tokens, spirit tokens or DM notes when a player moves their own token', async () => {
    useMap(true);
    await moveEnd(alice, 'pc-alice', 2, 6);

    for (const player of [alice, bob]) {
      const sent = JSON.stringify(received(player));
      expect(sent).not.toContain('lurker');
      expect(sent).not.toContain('wraith');
      expect(sent).not.toContain('DM secret');
    }
    // Alice's own token: position + full (filtered) data.
    expect(received(alice)).toEqual(
      expect.arrayContaining([
        ['token.moved', { tokenId: 'pc-alice', mapId: MAP_ID, x: 2, y: 6, movedBy: 'alice' }],
        ['token:appeared', { mapId: MAP_ID, token: { ...aliceToken, position: { x: 2, y: 6 } } }],
      ])
    );
    // DM: just the move.
    expect(received(dm)).toEqual([['token.moved', { tokenId: 'pc-alice', mapId: MAP_ID, x: 2, y: 6, movedBy: 'alice' }]]);
  });

  it('re-syncs only in-sight, role-visible tokens when the player\'s own token crosses the wall', async () => {
    useMap(true);
    await moveEnd(alice, 'pc-alice', 7, 4);

    const { notes: _notes, ...goblinView } = goblin;
    expect(received(alice)).toEqual(
      expect.arrayContaining([
        ['token.moved', { tokenId: 'pc-alice', mapId: MAP_ID, x: 7, y: 4, movedBy: 'alice' }],
        ['token:appeared', { mapId: MAP_ID, token: goblinView }],
        ['token:disappeared', { tokenId: 'orc', mapId: MAP_ID }],
        ['token:disappeared', { tokenId: 'pc-bob', mapId: MAP_ID }],
      ])
    );
    const sent = JSON.stringify(received(alice));
    expect(sent).not.toContain('lurker');
    expect(sent).not.toContain('wraith');
    expect(sent).not.toContain('DM secret');

    // Bob saw Alice before; now she is behind the wall.
    expect(received(bob)).toEqual([['token:disappeared', { tokenId: 'pc-alice', mapId: MAP_ID }]]);
  });

  it('sends players nothing when the DM moves a token outside their sight', async () => {
    useMap(true);
    await moveEnd(dm, 'goblin', 8, 5);

    expect(receivedTokenIds(dm)).toEqual(['goblin']);
    expect(alice.emit).not.toHaveBeenCalled();
    expect(bob.emit).not.toHaveBeenCalled();
  });

  it('sends players nothing when the DM moves a hidden token inside their sight', async () => {
    useMap(true);
    await moveEnd(dm, 'lurker', 3, 3);

    expect(receivedTokenIds(dm)).toEqual(['lurker']);
    expect(alice.emit).not.toHaveBeenCalled();
    expect(bob.emit).not.toHaveBeenCalled();
  });

  it('sends a token that walks into sight with DM notes stripped', async () => {
    useMap(true);
    await moveEnd(dm, 'goblin', 4, 5);

    const { notes: _notes, ...goblinView } = goblin;
    expect(received(alice)).toEqual([
      ['token.moved', { tokenId: 'goblin', mapId: MAP_ID, x: 4, y: 5, movedBy: 'dm-user' }],
      ['token:appeared', { mapId: MAP_ID, token: { ...goblinView, position: { x: 4, y: 5 } } }],
    ]);
  });

  it('sends token:disappeared only to players who saw the token', async () => {
    useMap(true);
    await moveEnd(dm, 'orc', 8, 6);

    expect(received(alice)).toEqual([['token:disappeared', { tokenId: 'orc', mapId: MAP_ID }]]);
    expect(received(bob)).toEqual([['token:disappeared', { tokenId: 'orc', mapId: MAP_ID }]]);
  });
});

describe('token.move.start / token.move', () => {
  it('does not announce a hidden token\'s drag to players', async () => {
    useMap(false);
    await moveStart(dm, 'lurker');
    await moveFrame(dm, 'lurker', 4, 4);

    expect(alice.emit).not.toHaveBeenCalled();
    expect(bob.emit).not.toHaveBeenCalled();
  });

  it('still announces a visible token\'s drag to the other sockets', async () => {
    useMap(false);
    await moveStart(dm, 'orc');
    await moveFrame(dm, 'orc', 4, 6);

    for (const player of [alice, bob]) {
      expect(received(player)).toEqual([
        ['token.move.start', { tokenId: 'orc', mapId: MAP_ID, movedBy: 'dm-user' }],
        ['token.moved', { tokenId: 'orc', mapId: MAP_ID, x: 4, y: 6, movedBy: 'dm-user' }],
      ]);
    }
    expect(dm.emit).not.toHaveBeenCalled();
  });

  it('on a lighting map sends drag frames only to players who see the token', async () => {
    useMap(true);
    await moveStart(dm, 'goblin');
    await moveFrame(dm, 'goblin', 8, 5);

    expect(alice.emit).not.toHaveBeenCalled();
    expect(bob.emit).not.toHaveBeenCalled();

    // In sight of both players (west of the wall).
    await moveFrame(dm, 'orc', 3, 7);
    expect(receivedTokenIds(alice)).toEqual(['orc']);
    expect(receivedTokenIds(bob)).toEqual(['orc']);
  });
});

describe('drag frame cost and ordering', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  function movedXs(s: FakeSocket): number[] {
    return s.emit.mock.calls.filter(([event]) => event === 'token.moved').map(([, p]) => p.x);
  }

  it('reads the map once per drag: identical and further frames reuse it', async () => {
    useMap(true);
    registerTokenHandlers(io as any, dm as any);
    await dm.handlers['token.move.start']({ tokenId: 'orc', mapId: MAP_ID });
    const readsAfterStart = db.map.findUnique.mock.calls.length;
    const membershipReadsAfterStart = db.campaignMembership.findMany.mock.calls.length;

    for (let i = 0; i < 3; i++) {
      dm.handlers['token.move']({ tokenId: 'orc', mapId: MAP_ID, x: 3, y: 7 });
      await sleep(20); // past the 16 ms throttle
      await flush();
    }
    dm.handlers['token.move']({ tokenId: 'orc', mapId: MAP_ID, x: 4, y: 7 });
    await sleep(20);
    await flush();

    expect(db.map.findUnique.mock.calls.length).toBe(readsAfterStart);
    expect(db.campaignMembership.findMany.mock.calls.length).toBe(membershipReadsAfterStart);
    // Identical frames are sent once.
    expect(movedXs(alice)).toEqual([3, 4]);
  });

  it('does not re-send an identical frame', async () => {
    useMap(false);
    registerTokenHandlers(io as any, dm as any);
    dm.handlers['token.move']({ tokenId: 'orc', mapId: MAP_ID, x: 3, y: 7 });
    await sleep(20);
    await flush();
    const readsAfterFirstFrame = db.map.findUnique.mock.calls.length;
    dm.handlers['token.move']({ tokenId: 'orc', mapId: MAP_ID, x: 3, y: 7 });
    await sleep(20);
    await flush();

    expect(movedXs(alice)).toEqual([3]);
    expect(db.map.findUnique.mock.calls.length).toBe(readsAfterFirstFrame);
  });

  it('processes frames one at a time, in order, dropping stale waiting frames', async () => {
    const slowRead = deferred<unknown>();
    db.map.findUnique.mockImplementationOnce(() => slowRead.promise);
    db.map.findUnique.mockResolvedValue(mapWith(false));
    registerTokenHandlers(io as any, dm as any);

    dm.handlers['token.move']({ tokenId: 'orc', mapId: MAP_ID, x: 1, y: 7 }); // A: in flight, map read hangs
    await sleep(20);
    dm.handlers['token.move']({ tokenId: 'orc', mapId: MAP_ID, x: 2, y: 7 }); // B: waits
    await sleep(20);
    dm.handlers['token.move']({ tokenId: 'orc', mapId: MAP_ID, x: 3, y: 7 }); // C: replaces B
    await sleep(20);
    expect(movedXs(alice)).toEqual([]);

    slowRead.resolve(mapWith(false));
    await flush();

    expect(movedXs(alice)).toEqual([1, 3]);
  });

  it('sends the final position after any frame still being processed', async () => {
    const slowRead = deferred<unknown>();
    db.map.findUnique.mockImplementationOnce(() => slowRead.promise);
    db.map.findUnique.mockResolvedValue(mapWith(false));
    registerTokenHandlers(io as any, dm as any);

    dm.handlers['token.move']({ tokenId: 'orc', mapId: MAP_ID, x: 1, y: 7 }); // in flight
    await sleep(20);
    dm.handlers['token.move']({ tokenId: 'orc', mapId: MAP_ID, x: 2, y: 7 }); // waiting: dropped by move.end
    const end = dm.handlers['token.move.end']({ tokenId: 'orc', mapId: MAP_ID, x: 4, y: 7 });
    await sleep(5);
    slowRead.resolve(mapWith(false));
    await end;
    await sleep(20);
    await flush();

    expect(movedXs(alice)).toEqual([1, 4]);
  });
});

describe('players in the spirit realm on a map without lighting', () => {
  // Bob has personally crossed over: his own token is on the spirit layer of
  // the campaign's current map, so he sees only spirit-layer tokens.
  function useCrossoverMap() {
    const bobSpirit = token('pc-bob', 1, 2, { controlledBy: 'bob', sightRadius: 0, layer: 'spirit' });
    db.map.findUnique.mockResolvedValue(mapWith(false, [aliceToken, bobSpirit, lurker, orc, wraith, goblin]));
  }

  it('sends material-token drag frames and the final move only to viewers on the material plane', async () => {
    useCrossoverMap();
    await moveStart(dm, 'orc');
    await moveFrame(dm, 'orc', 4, 6);
    await moveEnd(dm, 'orc', 4, 7);

    expect(receivedTokenIds(alice)).toEqual(['orc', 'orc', 'orc']);
    expect(bob.emit).not.toHaveBeenCalled();
  });

  it('sends spirit-token moves to the spirit-realm player only', async () => {
    useCrossoverMap();
    await moveEnd(dm, 'wraith', 4, 4);

    expect(receivedTokenIds(bob)).toEqual(['wraith']);
    expect(alice.emit).not.toHaveBeenCalled();
  });

  it('keeps the whole-room shortcut when nobody is in the spirit realm', async () => {
    useMap(false);
    await moveEnd(dm, 'orc', 4, 7);

    expect(receivedTokenIds(alice)).toEqual(['orc']);
    expect(receivedTokenIds(bob)).toEqual(['orc']);
  });
});

describe('drag context invalidation', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('applies a token the DM hides mid-drag on the next frame', async () => {
    const { setSocketInstance, broadcastTokenEvent } = jest.requireActual('../utils');
    setSocketInstance(io as any);
    useMap(false);
    registerTokenHandlers(io as any, bob as any);
    // Bob drags his own token; Alice sees each frame.
    await bob.handlers['token.move.start']({ tokenId: 'pc-bob', mapId: MAP_ID });
    bob.handlers['token.move']({ tokenId: 'pc-bob', mapId: MAP_ID, x: 1, y: 3 });
    await sleep(20);
    await flush();
    expect(receivedTokenIds(alice)).toEqual(['pc-bob', 'pc-bob']);

    // Meanwhile the DM hides Bob's token through the REST route.
    const hidden = { ...bobToken, visible: false };
    db.map.findUnique.mockResolvedValue(mapWith(false, [aliceToken, hidden, lurker, orc, wraith, goblin]));
    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, bobToken, hidden);
    alice.emit.mockClear();

    bob.handlers['token.move']({ tokenId: 'pc-bob', mapId: MAP_ID, x: 1, y: 4 });
    await sleep(20);
    await flush();

    expect(receivedTokenIds(alice)).toEqual([]);
  });

  it('applies a door the DM closes mid-drag on the next frame', async () => {
    const { setSocketInstance, broadcastMapViewChange } = jest.requireActual('../utils');
    setSocketInstance(io as any);
    const door = { ...WALL, type: 'door-open' };
    db.map.findUnique.mockResolvedValue({ ...mapWith(true), wallSegments: [door] });
    registerTokenHandlers(io as any, dm as any);
    await dm.handlers['token.move.start']({ tokenId: 'goblin', mapId: MAP_ID });
    dm.handlers['token.move']({ tokenId: 'goblin', mapId: MAP_ID, x: 7, y: 6 });
    await sleep(20);
    await flush();
    expect(receivedTokenIds(alice)).toEqual(['goblin', 'goblin']);

    db.map.findUnique.mockResolvedValue({ ...mapWith(true), wallSegments: [{ ...WALL, type: 'door-closed' }] });
    await broadcastMapViewChange(CAMPAIGN_ID, MAP_ID, { wallSegments: [door] });
    alice.emit.mockClear();

    dm.handlers['token.move']({ tokenId: 'goblin', mapId: MAP_ID, x: 7, y: 7 });
    await sleep(20);
    await flush();

    expect(receivedTokenIds(alice)).toEqual([]);
  });
});
