/**
 * character.hp.update handler unit test
 * Mocked Prisma and a fake Socket.io server — no database required.
 * (events.integration.test.ts covers the wire contract against PostgreSQL.)
 */

jest.mock('../../config/database', () => ({
  prisma: {
    character: { findUnique: jest.fn(), update: jest.fn() },
    campaignMembership: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
  },
}));

import { prisma } from '../../config/database';
import { registerCharacterHandlers } from '../handlers/characters';

const db = prisma as unknown as {
  character: { findUnique: jest.Mock; update: jest.Mock };
  campaignMembership: { findFirst: jest.Mock };
  user: { findUnique: jest.Mock };
};

function setup(gameSystem: string, data: Record<string, unknown>) {
  const character = { id: 'char-1', userId: 'owner', campaignId: 'camp-1', gameSystem, name: 'Robin', data };
  db.character.findUnique.mockResolvedValue(JSON.parse(JSON.stringify(character)));
  db.campaignMembership.findFirst.mockResolvedValue({ campaignId: 'camp-1', characterIds: ['char-1'] });
  db.character.update.mockImplementation(async ({ data: update }: any) => ({
    ...character,
    data: update.data,
    updatedAt: new Date('2026-09-26T10:00:00.000Z'),
  }));
  db.user.findUnique.mockResolvedValue({ displayName: 'Václav' });

  const roomEmit = jest.fn();
  const io = { to: jest.fn(() => ({ emit: roomEmit })) };
  const handlers: Record<string, (payload: unknown) => Promise<void>> = {};
  const socket = {
    userId: 'owner',
    campaignId: 'camp-1',
    role: 'PLAYER',
    on: jest.fn((event: string, handler: any) => {
      handlers[event] = handler;
    }),
    emit: jest.fn(),
  };

  registerCharacterHandlers(io as any, socket as any);
  return { io, roomEmit, socket, handler: handlers['character.hp.update'] };
}

beforeEach(() => jest.clearAllMocks());

test('emits character.updated with changedPaths ["hp.current"] after character.hp.updated', async () => {
  const { roomEmit, io, socket, handler } = setup('DND_5E', { hp: { current: 8, maximum: 10, temporary: 0 } });

  await handler({ characterId: 'char-1', delta: -3 });

  expect(socket.emit).not.toHaveBeenCalled();
  expect(io.to).toHaveBeenCalledWith('camp-1');
  expect(roomEmit.mock.calls.map(([event]) => event)).toEqual([
    'character.hp.updated',
    'character.updated',
  ]);
  expect(roomEmit.mock.calls[0][1]).toEqual({
    characterId: 'char-1',
    hp: { current: 5, max: 10, temp: 0 },
  });

  const payload = roomEmit.mock.calls[1][1];
  expect(payload).toEqual({
    characterId: 'char-1',
    character: expect.objectContaining({ id: 'char-1' }),
    userId: 'owner',
    changedPaths: ['hp.current'],
    updatedBy: { userId: 'owner', displayName: 'Václav' },
  });
  // character is the saved row
  expect(payload.character).toBe(await db.character.update.mock.results[0].value);
  expect(payload.character.data.hp.current).toBe(5);
  expect(db.user.findUnique).toHaveBeenCalledWith({
    where: { id: 'owner' },
    select: { displayName: true },
  });
});

test('uses the system HP path for Call of Cthulhu', async () => {
  const { roomEmit, handler } = setup('CALL_OF_CTHULHU_7E', {
    derivedStats: { hp: { current: 10, maximum: 12 } },
  });

  await handler({ characterId: 'char-1', delta: 1 });

  expect(roomEmit.mock.calls[1][0]).toBe('character.updated');
  expect(roomEmit.mock.calls[1][1].changedPaths).toEqual(['derivedStats.hp.current']);
});

test('falls back to "Unknown" when the user has no display name record', async () => {
  const { roomEmit, handler } = setup('DND_5E', { hp: { current: 8, maximum: 10 } });
  db.user.findUnique.mockResolvedValue(null);

  await handler({ characterId: 'char-1', delta: 1 });

  expect(roomEmit.mock.calls[1][1].updatedBy).toEqual({ userId: 'owner', displayName: 'Unknown' });
});

test('emits nothing when permission is denied', async () => {
  const { roomEmit, socket, handler } = setup('DND_5E', { hp: { current: 8, maximum: 10 } });
  socket.userId = 'someone-else';

  await handler({ characterId: 'char-1', delta: 1 });

  expect(roomEmit).not.toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith('error', expect.anything());
});
