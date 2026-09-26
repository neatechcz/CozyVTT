/**
 * authenticate / disconnect lifecycle unit test: quiet campaign join and
 * campaign switching. Mocked Prisma and domain handlers, the real
 * authenticateCampaign, and a fake socket — no database.
 *
 * A quiet socket (the standalone character editor page) joins the campaign
 * room and receives every campaign event, but is never announced: no
 * "has joined/left the campaign" system message and no user.joined /
 * user.left, on join, on campaign switch or on disconnect.
 */

jest.mock('../../config/database', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    campaign: { findUnique: jest.fn() },
    campaignMembership: { findUnique: jest.fn() },
  },
}));
jest.mock('../auth', () => ({
  ...jest.requireActual('../auth'),
  authenticateSocket: jest.fn(),
}));
jest.mock('../utils', () => ({ sendSystemMessage: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../handlers/tokens', () => ({ registerTokenHandlers: jest.fn() }));
jest.mock('../handlers/dice', () => ({ registerDiceHandlers: jest.fn() }));
jest.mock('../handlers/chat', () => ({ registerChatHandlers: jest.fn() }));
jest.mock('../handlers/spirit', () => ({ registerSpiritHandlers: jest.fn() }));
jest.mock('../handlers/vibe', () => ({ registerVibeHandlers: jest.fn() }));
jest.mock('../handlers/maps', () => ({ registerMapHandlers: jest.fn() }));
jest.mock('../handlers/atmosphere', () => ({ registerAtmosphereHandlers: jest.fn() }));
jest.mock('../handlers/characters', () => ({ registerCharacterHandlers: jest.fn() }));
jest.mock('../handlers/initiative', () => ({ registerInitiativeHandlers: jest.fn() }));
jest.mock('../handlers/walls', () => ({ registerWallHandlers: jest.fn() }));
jest.mock('../handlers/fog', () => ({ registerFogHandlers: jest.fn() }));
jest.mock('../handlers/lights', () => ({ registerLightHandlers: jest.fn() }));

import { prisma } from '../../config/database';
import { authenticateSocket } from '../auth';
import { sendSystemMessage } from '../utils';
import { registerEventHandlers } from '../events';

const findUser = prisma.user.findUnique as jest.Mock;
const authSocket = authenticateSocket as jest.Mock;
const findCampaign = prisma.campaign.findUnique as jest.Mock;
const findMembership = prisma.campaignMembership.findUnique as jest.Mock;
const systemMessage = sendSystemMessage as jest.Mock;

type Handler = (payload?: unknown) => Promise<void> | void;

async function connectSocket() {
  const handlers: Record<string, Handler> = {};
  const roomEmits: { room: string; event: string; payload: unknown }[] = [];
  const socket: any = {
    id: 'sock-1',
    userId: 'user-1',
    rooms: new Set<string>(['sock-1']),
    request: {},
    on: jest.fn((event: string, handler: Handler) => {
      handlers[event] = handler;
    }),
    emit: jest.fn(),
    join: jest.fn((room: string) => {
      socket.rooms.add(room);
    }),
    leave: jest.fn(async (room: string) => {
      socket.rooms.delete(room);
    }),
    to: jest.fn((room: string) => ({
      emit: (event: string, payload: unknown) => roomEmits.push({ room, event, payload }),
    })),
    disconnect: jest.fn(),
  };

  let onConnection: (s: unknown) => Promise<void> = async () => undefined;
  const io = {
    on: jest.fn((event: string, handler: (s: unknown) => Promise<void>) => {
      if (event === 'connection') onConnection = handler;
    }),
  };
  registerEventHandlers(io as any);
  await onConnection(socket);

  const emitted = (event: string) =>
    socket.emit.mock.calls.filter(([name]: [string]) => name === event).map(([, payload]: [string, unknown]) => payload);
  const roomEvents = (event: string) => roomEmits.filter((e) => e.event === event);

  return { socket, handlers, emitted, roomEvents };
}

beforeEach(() => {
  jest.clearAllMocks();
  authSocket.mockResolvedValue(true);
  // user-1 is a PLAYER in camp-1 and the DM of camp-2; not a member of camp-3
  const roles: Record<string, string> = { 'camp-1': 'PLAYER', 'camp-2': 'DM' };
  findCampaign.mockImplementation(async ({ where }: any) => ({ id: where.id, name: where.id, status: 'ACTIVE' }));
  findMembership.mockImplementation(async ({ where }: any) => {
    const role = roles[where.userId_campaignId.campaignId];
    return role ? { role } : null;
  });
  findUser.mockResolvedValue({ displayName: 'Václav' });
});

describe('authenticate', () => {
  test('non-quiet join is announced (unchanged behaviour)', async () => {
    const { socket, handlers, emitted, roomEvents } = await connectSocket();

    await handlers.authenticate({ campaignId: 'camp-1' });

    expect(socket.join).toHaveBeenCalledWith('camp-1');
    expect(socket.campaignId).toBe('camp-1');
    expect(socket.quiet).toBe(false);
    expect(emitted('authenticated')).toEqual([
      expect.objectContaining({ userId: 'user-1', campaignId: 'camp-1', role: 'PLAYER' }),
    ]);
    expect(systemMessage).toHaveBeenCalledWith('camp-1', 'Václav has joined the campaign.', {
      userId: 'user-1',
      action: 'user.joined',
    });
    expect(roomEvents('user.joined')).toEqual([
      { room: 'camp-1', event: 'user.joined', payload: expect.objectContaining({ userId: 'user-1' }) },
    ]);
  });

  test('quiet join enters the room and is authenticated, but is not announced', async () => {
    const { socket, handlers, emitted, roomEvents } = await connectSocket();

    await handlers.authenticate({ campaignId: 'camp-1', quiet: true });

    expect(socket.join).toHaveBeenCalledWith('camp-1');
    expect(socket.rooms.has('camp-1')).toBe(true);
    expect(socket.campaignId).toBe('camp-1');
    expect(socket.quiet).toBe(true);
    expect(emitted('authenticated')).toEqual([
      expect.objectContaining({ userId: 'user-1', campaignId: 'camp-1', role: 'PLAYER' }),
    ]);
    expect(systemMessage).not.toHaveBeenCalled();
    expect(roomEvents('user.joined')).toEqual([]);
  });

  test('quiet join is still refused without campaign membership', async () => {
    const { socket, handlers, emitted } = await connectSocket();

    await handlers.authenticate({ campaignId: 'camp-3', quiet: true });

    expect(socket.join).not.toHaveBeenCalledWith('camp-3');
    expect(socket.campaignId).toBeUndefined();
    expect(emitted('error')).toEqual([{ message: 'You are not a member of this campaign' }]);
    expect(emitted('authenticated')).toEqual([]);
  });

  test('a quiet socket switching campaigns announces neither the leave nor the join', async () => {
    const { socket, handlers, roomEvents } = await connectSocket();
    await handlers.authenticate({ campaignId: 'camp-1', quiet: true });

    await handlers.authenticate({ campaignId: 'camp-2', quiet: true });

    expect(socket.leave).toHaveBeenCalledWith('camp-1');
    expect(socket.join).toHaveBeenCalledWith('camp-2');
    expect(socket.campaignId).toBe('camp-2');
    expect(roomEvents('user.left')).toEqual([]);
    expect(roomEvents('user.joined')).toEqual([]);
    expect(systemMessage).not.toHaveBeenCalled();
  });

  test('a normal socket switching campaigns still announces the leave (unchanged behaviour)', async () => {
    const { handlers, roomEvents } = await connectSocket();
    await handlers.authenticate({ campaignId: 'camp-1' });

    await handlers.authenticate({ campaignId: 'camp-2' });

    expect(roomEvents('user.left')).toEqual([
      { room: 'camp-1', event: 'user.left', payload: expect.objectContaining({ userId: 'user-1' }) },
    ]);
    expect(roomEvents('user.joined').map((e) => e.room)).toEqual(['camp-1', 'camp-2']);
  });

  test('the leave of the old campaign follows how that campaign was joined', async () => {
    const { handlers, roomEvents } = await connectSocket();
    await handlers.authenticate({ campaignId: 'camp-1', quiet: true });

    await handlers.authenticate({ campaignId: 'camp-2' });

    // camp-1 never saw a join, so it sees no leave; camp-2 sees the join
    expect(roomEvents('user.left')).toEqual([]);
    expect(roomEvents('user.joined').map((e) => e.room)).toEqual(['camp-2']);
    expect(systemMessage).toHaveBeenCalledTimes(1);
    expect(systemMessage).toHaveBeenCalledWith('camp-2', 'Václav has joined the campaign.', expect.anything());
  });
});

describe('campaign switch', () => {
  test('a switched socket leaves the old room: exactly one campaign room, with the new role', async () => {
    const { socket, handlers, emitted } = await connectSocket();
    await handlers.authenticate({ campaignId: 'camp-1' });
    expect(socket.role).toBe('PLAYER');

    await handlers.authenticate({ campaignId: 'camp-2' });

    expect(socket.leave).toHaveBeenCalledWith('camp-1');
    expect([...socket.rooms].sort()).toEqual(['camp-2', 'sock-1', 'user-1']);
    expect(socket.campaignId).toBe('camp-2');
    expect(socket.role).toBe('DM');
    expect(emitted('authenticated').map((p: any) => [p.campaignId, p.role])).toEqual([
      ['camp-1', 'PLAYER'],
      ['camp-2', 'DM'],
    ]);
  });

  test('a refused switch keeps the socket in its old campaign with its old role', async () => {
    const { socket, handlers, emitted, roomEvents } = await connectSocket();
    await handlers.authenticate({ campaignId: 'camp-1' });

    await handlers.authenticate({ campaignId: 'camp-3' });

    expect(emitted('error')).toEqual([{ message: 'You are not a member of this campaign' }]);
    expect([...socket.rooms].sort()).toEqual(['camp-1', 'sock-1', 'user-1']);
    expect(socket.campaignId).toBe('camp-1');
    expect(socket.role).toBe('PLAYER');
    expect(roomEvents('user.left')).toEqual([]);
  });

  test('a quiet re-authenticate to an announced campaign keeps the announced leave', async () => {
    const { handlers, roomEvents } = await connectSocket();
    await handlers.authenticate({ campaignId: 'camp-1' });
    await handlers.authenticate({ campaignId: 'camp-1', quiet: true });
    systemMessage.mockClear();

    await handlers.disconnect('transport close');

    expect(systemMessage).toHaveBeenCalledWith('camp-1', 'Václav has left the campaign.', expect.anything());
    expect(roomEvents('user.left').map((e) => e.room)).toEqual(['camp-1']);
  });

  test('authenticateCampaign only validates — it does not move the socket', async () => {
    const { authenticateCampaign } = jest.requireActual('../auth');
    const socket: any = { userId: 'user-1', campaignId: 'camp-1', role: 'PLAYER' };

    const result = await authenticateCampaign(socket, 'camp-2');

    expect(result).toEqual({ success: true, role: 'DM' });
    expect(socket.campaignId).toBe('camp-1');
    expect(socket.role).toBe('PLAYER');
  });
});

describe('disconnect', () => {
  test('non-quiet disconnect is announced (unchanged behaviour)', async () => {
    const { handlers, roomEvents } = await connectSocket();
    await handlers.authenticate({ campaignId: 'camp-1' });
    systemMessage.mockClear();

    await handlers.disconnect('transport close');

    expect(systemMessage).toHaveBeenCalledWith('camp-1', 'Václav has left the campaign.', {
      userId: 'user-1',
      action: 'user.left',
    });
    expect(roomEvents('user.left')).toEqual([
      { room: 'camp-1', event: 'user.left', payload: expect.objectContaining({ userId: 'user-1' }) },
    ]);
  });

  test('quiet disconnect sends no system message and no user.left', async () => {
    const { socket, handlers, roomEvents } = await connectSocket();
    await handlers.authenticate({ campaignId: 'camp-1', quiet: true });

    await handlers.disconnect('client namespace disconnect');

    expect(systemMessage).not.toHaveBeenCalled();
    expect(roomEvents('user.left')).toEqual([]);
    expect(socket.leave).toHaveBeenCalledWith('camp-1');
  });
});
