/**
 * broadcastTokenEvent on a map with dynamic lighting enabled.
 *
 * Players must receive only the tokens inside their line of sight — the same
 * view `map.changed` gives them (filterTokensByRole, then filterTokensByLighting
 * with the recipient's userId). A token event can move what a player sees:
 * a token entering or leaving sight becomes `token.added` / `token.removed`,
 * and a change to the player's own token re-syncs every other token.
 * DMs are unaffected.
 *
 * No database: Prisma is mocked (the map as stored after the REST write) and
 * the Socket.io server is a fake whose campaign room holds the sockets.
 *
 * Fixture: 10×10 squares, gridSize 100 px, a solid wall along x = 500 px that
 * splits the map into a west half (columns 0–4) and an east half (5–9).
 * Players' tokens have unlimited sight (sightRadius 0), no light sources.
 */

jest.mock('../../config/database', () => ({
  prisma: {
    map: { findUnique: jest.fn() },
    campaignMembership: { findMany: jest.fn() },
    campaign: { findUnique: jest.fn() },
  },
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { prisma } from '../../config/database';
import { broadcastTokenEvent, setSocketInstance } from '../utils';

const CAMPAIGN_ID = 'campaign-1';
const MAP_ID = 'map-1';

const mockedPrisma = prisma as unknown as {
  map: { findUnique: jest.Mock };
  campaignMembership: { findMany: jest.Mock };
  campaign: { findUnique: jest.Mock };
};

type FakeSocket = { id: string; userId?: string; role: string; emit: jest.Mock };

function makeSocket(id: string, userId: string | undefined, role: string): FakeSocket {
  return { id, userId, role, emit: jest.fn() };
}

type TestToken = {
  id: string;
  name: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  layer: 'token' | 'spirit';
  visible: boolean;
  controlledBy: string | null;
  notes?: string;
  sightRadius?: number;
  hp?: { current: number; max: number; temp: number };
  [key: string]: unknown;
};

function token(id: string, x: number, y: number, overrides: Partial<TestToken> = {}): TestToken {
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
    notes: `DM secret about ${id}`,
    hp: { current: 7, max: 7, temp: 0 },
    ...overrides,
  };
}

function pc(id: string, x: number, y: number, userId: string, overrides: Partial<TestToken> = {}): TestToken {
  return token(id, x, y, { controlledBy: userId, sightRadius: 0, notes: undefined, ...overrides });
}

/** What a player receives: the token without DM-only notes. */
function playerView(t: TestToken) {
  const { notes: _notes, ...rest } = t;
  return rest;
}

const WALL = { id: 'wall-1', x1: 500, y1: 0, x2: 500, y2: 1000, type: 'wall' };

function lightingMap(tokens: TestToken[], overrides: Record<string, unknown> = {}) {
  return {
    id: MAP_ID,
    campaignId: CAMPAIGN_ID,
    width: 10,
    height: 10,
    gridSize: 100,
    tokens,
    wallSegments: [WALL],
    lights: [],
    lightingEnabled: true,
    ...overrides,
  };
}

/** Events a socket received, as [event, payload] tuples. */
function received(socket: FakeSocket) {
  return socket.emit.mock.calls.map(([event, payload]) => [event, payload]);
}

describe('broadcastTokenEvent on a lighting-enabled map', () => {
  let dm: FakeSocket;
  let alice: FakeSocket; // player, token west of the wall
  let bob: FakeSocket; // player, token west of the wall

  /** The map as the database holds it after the REST write. */
  function storedMap(tokens: TestToken[], overrides: Record<string, unknown> = {}) {
    mockedPrisma.map.findUnique.mockResolvedValue(lightingMap(tokens, overrides));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    dm = makeSocket('s-dm', 'dm-user', 'DM');
    alice = makeSocket('s-alice', 'alice', 'PLAYER');
    bob = makeSocket('s-bob', 'bob', 'PLAYER');
    const fetchSockets = jest.fn().mockResolvedValue([dm, alice, bob]);
    setSocketInstance({ in: jest.fn(() => ({ fetchSockets })), to: jest.fn() } as any);

    mockedPrisma.campaignMembership.findMany.mockResolvedValue([
      { userId: 'dm-user', role: 'DM' },
      { userId: 'alice', role: 'PLAYER' },
      { userId: 'bob', role: 'PLAYER' },
    ]);
    mockedPrisma.campaign.findUnique.mockResolvedValue({ spiritLayerEnabled: false, currentMapId: MAP_ID });
  });

  const aliceToken = pc('pc-alice', 2, 5, 'alice');
  const bobToken = pc('pc-bob', 1, 2, 'bob');

  it('does not send an update of a token outside every player\'s sight', async () => {
    const before = token('goblin', 7, 5);
    const after = token('goblin', 7, 5, { hp: { current: 3, max: 7, temp: 0 } });
    storedMap([aliceToken, bobToken, after]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, before, after);

    expect(received(dm)).toEqual([['token.updated', { mapId: MAP_ID, token: after }]]);
    expect(alice.emit).not.toHaveBeenCalled();
    expect(bob.emit).not.toHaveBeenCalled();
  });

  it('sends token.updated (notes stripped) for a token inside a player\'s sight', async () => {
    const before = token('orc', 3, 5);
    const after = token('orc', 3, 5, { hp: { current: 1, max: 7, temp: 0 } });
    storedMap([aliceToken, bobToken, after]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, before, after);

    expect(received(dm)).toEqual([['token.updated', { mapId: MAP_ID, token: after }]]);
    expect(received(alice)).toEqual([['token.updated', { mapId: MAP_ID, token: playerView(after) }]]);
    expect(received(bob)).toEqual([['token.updated', { mapId: MAP_ID, token: playerView(after) }]]);
  });

  it('sends token.added when a token moves into a player\'s sight', async () => {
    const before = token('goblin', 7, 5);
    const after = token('goblin', 3, 6);
    storedMap([aliceToken, bobToken, after]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, before, after);

    expect(received(dm)).toEqual([['token.updated', { mapId: MAP_ID, token: after }]]);
    expect(received(alice)).toEqual([['token.added', { mapId: MAP_ID, token: playerView(after) }]]);
  });

  it('sends token.removed when a token moves out of a player\'s sight', async () => {
    const before = token('orc', 3, 5);
    const after = token('orc', 8, 5);
    storedMap([aliceToken, bobToken, after]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, before, after);

    expect(received(dm)).toEqual([['token.updated', { mapId: MAP_ID, token: after }]]);
    expect(received(alice)).toEqual([['token.removed', { mapId: MAP_ID, tokenId: 'orc' }]]);
  });

  it('sends a created token only to players who can see where it was placed', async () => {
    const created = token('goblin', 8, 8);
    storedMap([aliceToken, bobToken, created]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, null, created);

    expect(received(dm)).toEqual([['token.added', { mapId: MAP_ID, token: created }]]);
    expect(alice.emit).not.toHaveBeenCalled();
    expect(bob.emit).not.toHaveBeenCalled();

    jest.clearAllMocks();
    const near = token('rat', 1, 1);
    storedMap([aliceToken, bobToken, created, near]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, null, near);

    expect(received(alice)).toEqual([['token.added', { mapId: MAP_ID, token: playerView(near) }]]);
  });

  it('sends no token.removed for a deleted token the player never saw', async () => {
    const removed = token('goblin', 7, 5);
    storedMap([aliceToken, bobToken]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, removed, null);

    expect(received(dm)).toEqual([['token.removed', { mapId: MAP_ID, tokenId: 'goblin' }]]);
    expect(alice.emit).not.toHaveBeenCalled();
  });

  it('re-syncs the other tokens when the player\'s own token moves across the wall', async () => {
    const orc = token('orc', 3, 5); // west: seen before, hidden after
    const goblin = token('goblin', 7, 5); // east: hidden before, seen after
    const afterAlice = pc('pc-alice', 7, 4, 'alice');
    storedMap([afterAlice, bobToken, orc, goblin]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, aliceToken, afterAlice);

    // DM: just the moved token.
    expect(received(dm)).toEqual([['token.updated', { mapId: MAP_ID, token: afterAlice }]]);

    // Alice: her own token, the goblin now in sight, the orc and Bob's token left behind the wall.
    expect(received(alice)).toHaveLength(4);
    expect(received(alice)).toEqual(
      expect.arrayContaining([
        ['token.updated', { mapId: MAP_ID, token: playerView(afterAlice) }],
        ['token.added', { mapId: MAP_ID, token: playerView(goblin) }],
        ['token.removed', { mapId: MAP_ID, tokenId: 'orc' }],
        ['token.removed', { mapId: MAP_ID, tokenId: 'pc-bob' }],
      ])
    );
    // The moved token's own event comes first.
    expect(received(alice)[0]).toEqual(['token.updated', { mapId: MAP_ID, token: playerView(afterAlice) }]);

    // Bob: Alice's token walked out of his sight; nothing else changed for him.
    expect(received(bob)).toEqual([['token.removed', { mapId: MAP_ID, tokenId: 'pc-alice' }]]);
  });

  it('gives a player sight from a token just assigned to them', async () => {
    const goblin = token('goblin', 8, 5);
    const before = token('scout', 7, 5); // east, uncontrolled: nobody sees it
    const after = token('scout', 7, 5, { controlledBy: 'alice', sightRadius: 0 });
    storedMap([aliceToken, bobToken, after, goblin]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, before, after);

    expect(received(alice)).toHaveLength(2);
    expect(received(alice)).toEqual(
      expect.arrayContaining([
        ['token.added', { mapId: MAP_ID, token: playerView(after) }],
        ['token.added', { mapId: MAP_ID, token: playerView(goblin) }],
      ])
    );
    expect(received(alice)[0][0]).toBe('token.added');
    expect((received(alice)[0][1] as { token: { id: string } }).token.id).toBe('scout');
    expect(bob.emit).not.toHaveBeenCalled();
  });

  it('never sends hidden tokens or DM notes in the re-sync', async () => {
    const lurker = token('lurker', 7, 6, { visible: false });
    const goblin = token('goblin', 7, 5);
    const afterAlice = pc('pc-alice', 7, 4, 'alice');
    storedMap([afterAlice, bobToken, lurker, goblin]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, aliceToken, afterAlice);

    const sent = JSON.stringify(received(alice));
    expect(sent).not.toContain('lurker');
    expect(sent).not.toContain('DM secret');
    expect(sent).toContain('goblin');
  });

  it('counts enabled light sources as sight, like map.changed', async () => {
    // A torch east of the wall lights the goblin even though Alice cannot see past the wall.
    const light = { id: 'torch', x: 750, y: 450, brightRadius: 2, dimRadius: 3, color: '#ffcc66', enabled: true };
    const before = token('goblin', 7, 5);
    const after = token('goblin', 7, 5, { name: 'Goblin chief' });
    storedMap([aliceToken, bobToken, after], { lights: [light] });

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, before, after);

    expect(received(alice)).toEqual([['token.updated', { mapId: MAP_ID, token: playerView(after) }]]);
  });

  it('computes every socket of the same user the same way', async () => {
    const alice2 = makeSocket('s-alice-2', 'alice', 'PLAYER');
    const fetchSockets = jest.fn().mockResolvedValue([dm, alice, alice2]);
    setSocketInstance({ in: jest.fn(() => ({ fetchSockets })), to: jest.fn() } as any);
    const before = token('goblin', 7, 5);
    const after = token('goblin', 3, 6);
    storedMap([aliceToken, after]);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, before, after);

    expect(received(alice)).toEqual([['token.added', { mapId: MAP_ID, token: playerView(after) }]]);
    expect(received(alice2)).toEqual(received(alice));
  });

  it('sends players nothing when the map can no longer be read (fails closed)', async () => {
    // Deleted concurrently: its lighting settings are unknown, so no player may be sent the token.
    mockedPrisma.map.findUnique.mockResolvedValue(null);
    const before = token('goblin', 7, 5);
    const after = token('goblin', 7, 5, { hp: { current: 3, max: 7, temp: 0 } });

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, before, after);

    expect(received(dm)).toEqual([['token.updated', { mapId: MAP_ID, token: after }]]);
    expect(alice.emit).not.toHaveBeenCalled();
    expect(bob.emit).not.toHaveBeenCalled();
  });

  it('does not read the map when only DMs are connected', async () => {
    const fetchSockets = jest.fn().mockResolvedValue([dm]);
    setSocketInstance({ in: jest.fn(() => ({ fetchSockets })), to: jest.fn() } as any);
    const after = token('goblin', 7, 5);

    await broadcastTokenEvent(CAMPAIGN_ID, MAP_ID, null, after);

    expect(received(dm)).toEqual([['token.added', { mapId: MAP_ID, token: after }]]);
    expect(mockedPrisma.map.findUnique).not.toHaveBeenCalled();
  });
});
