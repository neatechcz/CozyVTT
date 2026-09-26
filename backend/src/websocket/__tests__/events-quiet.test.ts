/**
 * Quiet campaign join (authenticate { quiet: true }) unit test.
 * Mocked Prisma, auth and domain handlers with a fake socket — no database.
 *
 * A quiet socket (the standalone character editor page) joins the campaign
 * room and receives every campaign event, but is never announced: no
 * "has joined/left the campaign" system message and no user.joined /
 * user.left, on join, on campaign switch or on disconnect.
 */

jest.mock('../../config/database', () => ({
  prisma: { user: { findUnique: jest.fn() } },
}));
jest.mock('../auth', () => ({
  authenticateSocket: jest.fn(),
  authenticateCampaign: jest.fn(),
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
import { authenticateSocket, authenticateCampaign } from '../auth';
import { sendSystemMessage } from '../utils';
import { registerEventHandlers } from '../events';

const findUser = prisma.user.findUnique as jest.Mock;
const authSocket = authenticateSocket as jest.Mock;
const authCampaign = authenticateCampaign as jest.Mock;
const systemMessage = sendSystemMessage as jest.Mock;

type Handler = (payload?: unknown) => Promise<void> | void;

async function connectSocket() {
  const handlers: Record<string, Handler> = {};
  const roomEmits: { room: string; event: string; payload: unknown }[] = [];
  const socket: any = {
    id: 'sock-1',
    userId: 'user-1',
    rooms: new Set<string>(['sock-1']),
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
  authCampaign.mockResolvedValue({ success: true, role: 'PLAYER' });
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

    expect(authCampaign).toHaveBeenCalledWith(socket, 'camp-1');
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
    authCampaign.mockResolvedValue({ success: false, error: 'Not a member of this campaign' });
    const { socket, handlers, emitted } = await connectSocket();

    await handlers.authenticate({ campaignId: 'camp-1', quiet: true });

    expect(socket.join).not.toHaveBeenCalledWith('camp-1');
    expect(socket.campaignId).toBeUndefined();
    expect(emitted('error')).toEqual([{ message: 'Not a member of this campaign' }]);
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
