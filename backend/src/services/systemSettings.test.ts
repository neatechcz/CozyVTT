jest.mock('../config/database', () => ({
  prisma: {
    systemSettings: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { count: jest.fn() },
  },
}));

import { prisma } from '../config/database';
import { markSetupCompleted } from './systemSettings';

const systemSettingsMock = jest.mocked(prisma.systemSettings);

describe('markSetupCompleted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    systemSettingsMock.findFirst.mockResolvedValue({ id: 'settings-row' } as never);
    systemSettingsMock.updateMany.mockResolvedValue({ count: 1 });
  });

  it('persists the first-run choices while marking setup complete', async () => {
    await markSetupCompleted({
      instanceName: 'Supplement Audit',
      timezone: 'Europe/Prague',
      allowRegistration: true,
    });

    expect(systemSettingsMock.updateMany).toHaveBeenCalledWith({
      data: {
        instanceName: 'Supplement Audit',
        timezone: 'Europe/Prague',
        allowRegistration: true,
        setupCompleted: true,
      },
    });
  });

  it('keeps the existing default settings when older clients omit setup choices', async () => {
    await markSetupCompleted();

    expect(systemSettingsMock.updateMany).toHaveBeenCalledWith({
      data: { setupCompleted: true },
    });
  });
});
