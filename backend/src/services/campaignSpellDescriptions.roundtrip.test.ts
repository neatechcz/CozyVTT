const mockDb = {
  systemSettings: { findFirst: jest.fn(async () => null) },
  campaign: {
    findUnique: jest.fn(),
    create: jest.fn(async ({ data }: any) => data),
    update: jest.fn(),
  },
  campaignMembership: { create: jest.fn(async ({ data }: any) => data) },
  campaignSpellDescription: { createMany: jest.fn(async () => ({ count: 1 })) },
};

jest.mock('../config/database', () => ({ prisma: mockDb }));
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { exportCampaign } from './campaignExporter';
import { importCampaign } from './campaignImporter';

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.campaign.findUnique.mockResolvedValue({
    id: 'source', name: 'Klenba', description: null, gameSystem: 'DND_5E',
    vibeSettings: { periods: [{ name: 'day', hue: '0', filter: 'none' }] },
    currentVibe: null, spiritLayerEnabled: false, spiritLayerStyle: 'wispy',
    maps: [], creatureTemplates: [], tokenTemplates: [],
    spellDescriptions: [{ name: 'Magic Missile', normalizedName: 'magicmissile', description: '**Three** darts.' }],
  });
});

it('preserves campaign spell descriptions across an export and import', async () => {
  const { buffer } = await exportCampaign('source');
  const imported = await importCampaign(buffer, 'new-dm');

  expect(mockDb.campaignSpellDescription.createMany).toHaveBeenCalledWith({
    data: [{ campaignId: imported.campaignId, name: 'Magic Missile',
      normalizedName: 'magicmissile', description: '**Three** darts.' }],
    skipDuplicates: true,
  });
});
