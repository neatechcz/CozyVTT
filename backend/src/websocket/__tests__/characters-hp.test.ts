/**
 * character.hp.update handler unit test
 * Mocked Prisma (with an interactive-transaction fake) and a fake Socket.io
 * server — no database required. (events.integration.test.ts covers the wire
 * contract against PostgreSQL.)
 */

jest.mock('../../config/database', () => ({
  prisma: {
    $transaction: jest.fn(),
    character: { findUnique: jest.fn(), update: jest.fn() },
    campaignMembership: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
  },
}));

import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { registerCharacterHandlers } from '../handlers/characters';

const db = prisma as unknown as {
  $transaction: jest.Mock;
  character: { findUnique: jest.Mock; update: jest.Mock };
  campaignMembership: { findFirst: jest.Mock };
  user: { findUnique: jest.Mock };
};

type Row = {
  id: string;
  userId: string;
  campaignId: string | null;
  gameSystem: string;
  name: string;
  data: Record<string, any>;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function setup(gameSystem: string, data: Record<string, unknown>, overrides: Partial<Row> = {}) {
  let stored: Row = {
    id: 'char-1',
    userId: 'owner',
    campaignId: 'camp-1',
    gameSystem,
    name: 'Robin',
    data: clone(data),
    ...overrides,
  };
  const order: string[] = [];

  // The transaction client is the only place character reads/writes may go.
  const tx = {
    $queryRaw: jest.fn(async () => {
      order.push('lock');
      return [];
    }),
    character: {
      findUnique: jest.fn(async () => {
        order.push('read');
        return clone(stored);
      }),
      update: jest.fn(async ({ data: update, include }: any) => {
        order.push('write');
        stored = { ...stored, ...clone(update) };
        return {
          ...clone(stored),
          ...(include?.campaign ? { campaign: { id: 'camp-1', name: 'Klenba' } } : {}),
        };
      }),
    },
    campaignMembership: {
      findFirst: jest.fn(async () => ({ campaignId: 'camp-1', characterIds: ['char-1'] })),
    },
  };
  db.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
    order.push('begin');
    const result = await fn(tx);
    order.push('commit');
    return result;
  });
  db.user.findUnique.mockResolvedValue({ displayName: 'Václav' });

  const roomEmit = jest.fn((event: string) => {
    order.push(`emit:${event}`);
  });
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
  return {
    io,
    roomEmit,
    socket,
    tx,
    order,
    stored: () => stored,
    setStored: (row: Row) => {
      stored = row;
    },
    handler: handlers['character.hp.update'],
  };
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
  expect((roomEmit.mock.calls[0] as unknown[])[1]).toEqual({
    characterId: 'char-1',
    hp: { current: 5, max: 10, temp: 0 },
  });

  const payload = (roomEmit.mock.calls[1] as unknown[])[1] as any;
  expect(payload).toEqual({
    characterId: 'char-1',
    character: expect.objectContaining({ id: 'char-1' }),
    userId: 'owner',
    changedPaths: ['hp.current'],
    updatedBy: { userId: 'owner', displayName: 'Václav' },
  });
  expect(payload.character.data.hp.current).toBe(5);
  expect(db.user.findUnique).toHaveBeenCalledWith({
    where: { id: 'owner' },
    select: { displayName: true },
  });
});

test('broadcast character includes campaign { id, name } like PUT/PATCH', async () => {
  const { roomEmit, handler } = setup('DND_5E', { hp: { current: 8, maximum: 10 } });

  await handler({ characterId: 'char-1', delta: -1 });

  const payload = (roomEmit.mock.calls[1] as unknown[])[1] as any;
  expect(payload.character.campaign).toEqual({ id: 'camp-1', name: 'Klenba' });
});

test('locks the row, reads and writes inside the transaction, broadcasts after commit', async () => {
  const { order, tx, handler } = setup('DND_5E', { hp: { current: 8, maximum: 10 } });

  await handler({ characterId: 'char-1', delta: -1 });

  expect(order).toEqual([
    'begin',
    'lock',
    'read',
    'write',
    'commit',
    'emit:character.hp.updated',
    'emit:character.updated',
  ]);
  const [strings, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
  expect(strings.join('$')).toContain('FOR UPDATE');
  expect(values).toEqual(['char-1']);
  expect(db.character.findUnique).not.toHaveBeenCalled();
  expect(db.character.update).not.toHaveBeenCalled();
});

test('a concurrent change to another path committed while waiting for the lock is not reverted', async () => {
  const ctx = setup('DND_5E', { hp: { current: 8, maximum: 10 }, notes: 'old' });
  ctx.tx.$queryRaw.mockImplementationOnce(async () => {
    ctx.order.push('lock');
    // Another writer (e.g. a PATCH) commits just before we get the lock.
    ctx.setStored({ ...ctx.stored(), data: { ...ctx.stored().data, notes: 'new' } });
    return [];
  });

  await ctx.handler({ characterId: 'char-1', delta: -2 });

  expect(ctx.stored().data).toEqual({ hp: { current: 6, maximum: 10 }, notes: 'new' });
});

test('uses the system HP path for Call of Cthulhu', async () => {
  const { roomEmit, handler } = setup('CALL_OF_CTHULHU_7E', {
    derivedStats: { hp: { current: 10, maximum: 12 } },
  });

  await handler({ characterId: 'char-1', delta: 1 });

  expect(roomEmit.mock.calls[1][0]).toBe('character.updated');
  expect(((roomEmit.mock.calls[1] as unknown[])[1] as any).changedPaths).toEqual(['derivedStats.hp.current']);
});

test('falls back to "Unknown" when the user has no display name record', async () => {
  const { roomEmit, handler } = setup('DND_5E', { hp: { current: 8, maximum: 10 } });
  db.user.findUnique.mockResolvedValue(null);

  await handler({ characterId: 'char-1', delta: 1 });

  expect(((roomEmit.mock.calls[1] as unknown[])[1] as any).updatedBy).toEqual({
    userId: 'owner',
    displayName: 'Unknown',
  });
});

test('emits nothing when permission is denied', async () => {
  const { roomEmit, socket, handler, stored } = setup('DND_5E', { hp: { current: 8, maximum: 10 } });
  socket.userId = 'someone-else';

  await handler({ characterId: 'char-1', delta: 1 });

  expect(roomEmit).not.toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith('error', expect.anything());
  expect(stored().data.hp.current).toBe(8);
});

test('refuses a character whose campaignId is not the socket campaign', async () => {
  const { roomEmit, socket, handler, stored, tx } = setup(
    'DND_5E',
    { hp: { current: 8, maximum: 10 } },
    { campaignId: 'other-campaign' }
  );

  await handler({ characterId: 'char-1', delta: -1 });

  expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Character is not in this campaign' });
  expect(tx.character.update).not.toHaveBeenCalled();
  expect(roomEmit).not.toHaveBeenCalled();
  expect(stored().data.hp.current).toBe(8);
});

test('a row lock timeout (Prisma P2028) is reported as "Character is busy", nothing broadcast', async () => {
  const { roomEmit, socket, handler } = setup('DND_5E', { hp: { current: 8, maximum: 10 } });
  db.$transaction.mockRejectedValueOnce(
    new Prisma.PrismaClientKnownRequestError('Transaction API error: Unable to start a transaction in the given time.', {
      code: 'P2028',
      clientVersion: 'test',
    })
  );

  await handler({ characterId: 'char-1', delta: -1 });

  expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Character is busy, retry shortly' });
  expect(roomEmit).not.toHaveBeenCalled();
});

test('the row lock transaction uses explicit maxWait / timeout', async () => {
  const { handler } = setup('DND_5E', { hp: { current: 8, maximum: 10 } });

  await handler({ characterId: 'char-1', delta: -1 });

  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 5000, timeout: 10000 });
});
