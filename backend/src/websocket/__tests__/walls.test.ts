/**
 * Wall handler broadcast origin: wall:added / wall:removed / wall:updated /
 * walls:replaced must carry `changedBy` (socket.userId) and `sourceSocketId`
 * (socket.id) so a client can tell its own optimistic echo from a change made
 * by another client (another DM socket, the AI narrator's MCP service
 * account, or a player toggling an unlocked door) — mirrors `token.moved`'s
 * `movedBy`. `walls:request`'s reply is unchanged (no origin: it is not a
 * change, just a sync).
 *
 * No database: Prisma is mocked, and `broadcastMapViewChange` (a separate,
 * unrelated player-view re-sync) is mocked out since it is not under test.
 */

jest.mock('../../config/database', () => ({
  prisma: {
    map: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils', () => ({ broadcastMapViewChange: jest.fn(async () => {}) }));

import { prisma } from '../../config/database';
import { registerWallHandlers } from '../handlers/walls';

const db = prisma as unknown as {
  map: { findUnique: jest.Mock; update: jest.Mock };
};

const CAMPAIGN_ID = 'camp-1';
const MAP_ID = 'map-1';
const SEGMENT_A = { id: '11111111-1111-4111-8111-111111111111', x1: 0, y1: 0, x2: 100, y2: 0, type: 'wall' };
const SEGMENT_B = { id: '22222222-2222-4222-8222-222222222222', x1: 0, y1: 0, x2: 0, y2: 100, type: 'wall' };

function setup(role: string, userId: string, socketId: string) {
  const roomEmit = jest.fn();
  const io = { to: jest.fn(() => ({ emit: roomEmit })) };
  const handlers: Record<string, (payload: unknown) => Promise<void>> = {};
  const socket = {
    id: socketId,
    userId,
    campaignId: CAMPAIGN_ID,
    role,
    on: jest.fn((event: string, handler: any) => {
      handlers[event] = handler;
    }),
    emit: jest.fn(),
  };

  registerWallHandlers(io as any, socket as any);
  return { io, roomEmit, socket, handlers };
}

/** Broadcasts sent to the campaign room, as [event, payload] tuples. */
function broadcasts(roomEmit: jest.Mock) {
  return roomEmit.mock.calls.map(([event, payload]) => [event, payload]);
}

describe('wall handlers broadcast an origin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('wall:added carries changedBy and sourceSocketId alongside mapId/segment', async () => {
    const { io, roomEmit, handlers } = setup('DM', 'dm-user', 'sock-dm-1');
    db.map.findUnique.mockResolvedValue({ campaignId: CAMPAIGN_ID, wallSegments: [] });
    db.map.update.mockResolvedValue({});

    await handlers['wall:add']({ mapId: MAP_ID, segment: SEGMENT_A });

    expect(io.to).toHaveBeenCalledWith(CAMPAIGN_ID);
    expect(broadcasts(roomEmit)).toEqual([
      ['wall:added', { mapId: MAP_ID, segment: SEGMENT_A, changedBy: 'dm-user', sourceSocketId: 'sock-dm-1' }],
    ]);
  });

  it('wall:removed carries changedBy and sourceSocketId alongside mapId/segmentId', async () => {
    const { roomEmit, handlers } = setup('DM', 'dm-user', 'sock-dm-2');
    db.map.findUnique.mockResolvedValue({ campaignId: CAMPAIGN_ID, wallSegments: [SEGMENT_A] });
    db.map.update.mockResolvedValue({});

    await handlers['wall:remove']({ mapId: MAP_ID, segmentId: SEGMENT_A.id });

    expect(broadcasts(roomEmit)).toEqual([
      ['wall:removed', { mapId: MAP_ID, segmentId: SEGMENT_A.id, changedBy: 'dm-user', sourceSocketId: 'sock-dm-2' }],
    ]);
  });

  it('wall:updated carries changedBy and sourceSocketId alongside mapId/segment (player door toggle)', async () => {
    const closedDoor = { id: SEGMENT_A.id, x1: 0, y1: 0, x2: 100, y2: 0, type: 'door-closed' };
    const openedDoor = { ...closedDoor, type: 'door-open' };
    const { roomEmit, handlers } = setup('PLAYER', 'alice', 'sock-alice-1');
    db.map.findUnique.mockResolvedValue({ campaignId: CAMPAIGN_ID, wallSegments: [closedDoor] });
    db.map.update.mockResolvedValue({});

    await handlers['wall:update']({ mapId: MAP_ID, segment: openedDoor });

    expect(broadcasts(roomEmit)).toEqual([
      ['wall:updated', { mapId: MAP_ID, segment: openedDoor, changedBy: 'alice', sourceSocketId: 'sock-alice-1' }],
    ]);
  });

  it('walls:replaced carries changedBy and sourceSocketId alongside mapId/segments', async () => {
    const { roomEmit, handlers } = setup('DM', 'dm-user', 'sock-dm-3');
    db.map.findUnique.mockResolvedValue({ campaignId: CAMPAIGN_ID, wallSegments: [SEGMENT_A] });
    db.map.update.mockResolvedValue({});

    await handlers['walls:replace']({ mapId: MAP_ID, segments: [SEGMENT_A, SEGMENT_B] });

    expect(broadcasts(roomEmit)).toEqual([
      [
        'walls:replaced',
        { mapId: MAP_ID, segments: [SEGMENT_A, SEGMENT_B], changedBy: 'dm-user', sourceSocketId: 'sock-dm-3' },
      ],
    ]);
  });

  it('walls:request replies to the requester only, without an origin', async () => {
    const { socket, handlers } = setup('PLAYER', 'alice', 'sock-alice-2');
    db.map.findUnique.mockResolvedValue({ campaignId: CAMPAIGN_ID, wallSegments: [SEGMENT_A] });

    await handlers['walls:request']({ mapId: MAP_ID });

    expect(socket.emit).toHaveBeenCalledWith('walls:replaced', { mapId: MAP_ID, segments: [SEGMENT_A] });
  });
});
