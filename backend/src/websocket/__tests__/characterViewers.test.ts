/**
 * Character sheet recipients: full sheets (character.updated, HP) go only to
 * the owner, campaign DMs and the assigned player — never the campaign room.
 * Mocked Prisma, fake Socket.io server — no database required.
 */

jest.mock('../../config/database', () => ({
  prisma: { campaignMembership: { findMany: jest.fn() } },
}));

import { prisma } from '../../config/database';
import { broadcastToCharacterViewers, getCharacterSheetRecipientIds, setSocketInstance } from '../utils';

const findMany = (prisma as unknown as { campaignMembership: { findMany: jest.Mock } }).campaignMembership.findMany;

beforeEach(() => jest.clearAllMocks());

test('recipients: owner plus DMs and assigned players, de-duplicated', async () => {
  findMany.mockResolvedValue([{ userId: 'dm' }, { userId: 'owner' }, { userId: 'assigned' }]);

  expect(await getCharacterSheetRecipientIds('camp-1', 'char-1', 'owner')).toEqual(['owner', 'dm', 'assigned']);
  expect(findMany).toHaveBeenCalledWith({
    where: {
      campaignId: 'camp-1',
      OR: [{ role: 'DM' }, { role: 'PLAYER', characterIds: { has: 'char-1' } }],
    },
    select: { userId: true },
  });
});

test('broadcastToCharacterViewers emits once to the recipients\' personal rooms', async () => {
  findMany.mockResolvedValue([{ userId: 'dm' }]);
  const emit = jest.fn();
  const io = { to: jest.fn(() => ({ emit })) };
  setSocketInstance(io as any);

  await broadcastToCharacterViewers({ id: 'char-1', campaignId: 'camp-1', userId: 'owner' }, 'character.updated', { x: 1 });

  expect(io.to).toHaveBeenCalledTimes(1);
  expect(io.to).toHaveBeenCalledWith(['owner', 'dm']);
  expect(emit).toHaveBeenCalledWith('character.updated', { x: 1 });
});

test('a character outside any campaign broadcasts nothing', async () => {
  const io = { to: jest.fn() };

  await broadcastToCharacterViewers({ id: 'char-1', campaignId: null, userId: 'owner' }, 'character.updated', {}, io as any);

  expect(findMany).not.toHaveBeenCalled();
  expect(io.to).not.toHaveBeenCalled();
});
