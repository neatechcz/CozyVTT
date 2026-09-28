/**
 * Which tracks a DM may set as their campaign's ambience.
 *
 * Setting a track is what makes it readable by the whole campaign: the read
 * rule grants a member access to the track their campaign is playing, because
 * each player's browser fetches it for itself. That makes this handler a place
 * where one person's private file can be opened to a roomful of people, so it
 * has to ask the same question the serving route asks: may *this DM* read it?
 *
 * Without that, a DM could type any asset id into the setting and hand their
 * table a stranger's private recording.
 *
 * Requires PostgreSQL at DATABASE_URL.
 */

import { randomUUID } from 'crypto';
import type { Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../../config/database';
import {
  createWsTestServer,
  waitForEvent,
  expectNoEvent,
  WsTestServer,
} from '../../__tests__/helpers/websocket-test-server';

jest.setTimeout(20000);

const runId = randomUUID().slice(0, 8);
const email = (name: string) => `atmoset-${name}-${runId}@test.cozyvtt.local`;

let server: WsTestServer;
let dmId: string;
let outsiderId: string;
let campaignId: string;
let dmCookie: string;
let dmTrackId: string;
let strangersTrackId: string;
let globalTrackId: string;

async function audioAsset(uploaderId: string, scope: 'USER' | 'GLOBAL', name: string): Promise<string> {
  const asset = await prisma.asset.create({
    data: {
      type: 'AUDIO', scope, uploadedById: uploaderId,
      filename: `${name}.mp3`, originalName: `${name}.mp3`, mimeType: 'audio/mpeg',
      fileSize: 1, filePath: `/nonexistent/${name}.mp3`, name,
    },
  });
  return asset.id;
}

/** What the campaign has recorded as its ambience right now. */
async function currentTrack(): Promise<string | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { vibeSettings: true },
  });
  const settings = campaign?.vibeSettings as { atmosphereAudio?: { assetId?: string } } | null;
  return settings?.atmosphereAudio?.assetId ?? null;
}

beforeAll(async () => {
  const [dm, outsider] = await Promise.all(
    ['dm', 'outsider'].map((name) =>
      prisma.user.create({
        data: { email: email(name), passwordHash: 'not-used-by-socket-auth', displayName: `Atmoset ${name}` },
      })
    )
  );
  dmId = dm.id;
  outsiderId = outsider.id;

  campaignId = (await prisma.campaign.create({
    data: { name: `Atmoset ${runId}`, ownerId: dmId, vibeSettings: {} },
  })).id;
  await prisma.campaignMembership.create({
    data: { userId: dmId, campaignId, role: 'DM', characterIds: [] },
  });

  dmTrackId = await audioAsset(dmId, 'USER', 'dms-own-rain');
  strangersTrackId = await audioAsset(outsiderId, 'USER', 'private-recording');
  globalTrackId = await audioAsset(outsiderId, 'GLOBAL', 'shared-ambience');

  server = await createWsTestServer();
  dmCookie = await server.loginAs(dmId);
});

afterAll(async () => {
  await server?.close();
  await prisma.asset.deleteMany({ where: { uploadedById: { in: [dmId, outsiderId] } } });
  await prisma.campaign.deleteMany({ where: { id: campaignId } });
  await prisma.user.deleteMany({ where: { id: { in: [dmId, outsiderId] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.campaign.update({ where: { id: campaignId }, data: { vibeSettings: {} } });
});

describe('atmosphere.audio.set', () => {
  let dmClient: ClientSocket;

  beforeEach(async () => {
    dmClient = await server.connectAndAuth(dmCookie, campaignId);
  });

  afterEach(() => {
    dmClient.disconnect();
  });

  it('accepts a track from the DM\'s own library', async () => {
    const updated = waitForEvent<{ assetId: string }>(dmClient, 'atmosphere.audio.updated');
    dmClient.emit('atmosphere.audio.set', { assetId: dmTrackId });
    expect((await updated).assetId).toBe(dmTrackId);
    expect(await currentTrack()).toBe(dmTrackId);
  });

  it('accepts a global track anyone may read', async () => {
    const updated = waitForEvent<{ assetId: string }>(dmClient, 'atmosphere.audio.updated');
    dmClient.emit('atmosphere.audio.set', { assetId: globalTrackId });
    expect((await updated).assetId).toBe(globalTrackId);
  });

  it('refuses a private track belonging to somebody else', async () => {
    // Setting it would make it readable by every member of this campaign.
    const refused = waitForEvent<{ message: string }>(dmClient, 'error');
    dmClient.emit('atmosphere.audio.set', { assetId: strangersTrackId });
    expect((await refused).message).toMatch(/not found/i);
    expect(await currentTrack()).toBeNull();
  });

  it('does not tell the campaign about a track it refused', async () => {
    const silence = expectNoEvent(dmClient, 'atmosphere.audio.updated');
    dmClient.emit('atmosphere.audio.set', { assetId: strangersTrackId });
    await silence;
  });

  it('still refuses an asset that does not exist', async () => {
    const refused = waitForEvent<{ message: string }>(dmClient, 'error');
    dmClient.emit('atmosphere.audio.set', { assetId: randomUUID() });
    expect((await refused).message).toMatch(/not found/i);
  });

  it('lets the DM stop the audio', async () => {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { vibeSettings: { atmosphereAudio: { assetId: dmTrackId, volume: 0.5, loop: true } } },
    });
    const updated = waitForEvent<{ assetId: string | null }>(dmClient, 'atmosphere.audio.updated');
    dmClient.emit('atmosphere.audio.set', { assetId: null });
    expect((await updated).assetId).toBeNull();
    expect(await currentTrack()).toBeNull();
  });
});
