import { Prisma } from '@prisma/client';
import {
  COMBAT_STATE_TX_OPTIONS,
  loadCampaignCombatState,
  lockCampaignMapRows,
  saveCampaignCombatState,
  withCampaignRowLock,
  withCampaignMapRowLock,
} from '../combatStatePersistence';
import { defaultCombatState, type CombatState } from '../../websocket/initiativeState';

const campaignRow = {
  id: 'campaign-1',
  combatState: null as Prisma.JsonValue | null,
};
const mapRow = {
  id: 'map-1',
  campaignId: 'campaign-1',
  tokens: [],
};

function makePrisma() {
  const order: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async (query: TemplateStringsArray) => {
      const sql = query.join(' ');
      order.push(sql.includes('"Map"') ? 'lock-map' : 'lock-campaign');
      return [{ id: sql.includes('"Map"') ? mapRow.id : campaignRow.id }];
    }),
    campaign: {
      findUnique: jest.fn(async () => {
        order.push('read-campaign');
        return { ...campaignRow };
      }),
      update: jest.fn(async ({ data }: { data: { combatState: unknown } }) => {
        order.push('write-campaign');
        campaignRow.combatState = data.combatState === Prisma.DbNull
          ? null
          : data.combatState as Prisma.JsonValue;
        return { ...campaignRow };
      }),
    },
    map: {
      findFirst: jest.fn(async () => {
        order.push('read-map');
        return { ...mapRow };
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async <T>(fn: (client: typeof tx) => Promise<T>) => {
      order.push('begin');
      const value = await fn(tx);
      order.push('commit');
      return value;
    }),
    campaign: {
      findUnique: jest.fn(async () => ({ ...campaignRow })),
    },
  };
  return { prisma, tx, order };
}

const savedState: CombatState = {
  active: true,
  round: 2,
  currentTokenId: 'token-1',
  combatants: [],
  combatId: 'combat-1',
  turnId: 'turn-2',
  mapId: 'map-1',
  movement: {
    tokenId: 'token-1',
    turnId: 'turn-2',
    speedFeet: 30,
    spentFeet: 10,
    dashBonusFeet: 0,
    dashUsed: false,
    diagonalStepsTaken: 2,
    remainingMovementFeet: 20,
  },
};

describe('campaign combat-state persistence', () => {
  beforeEach(() => {
    campaignRow.combatState = null;
  });

  it('locks Campaign before invoking every combat mutation callback', async () => {
    const { prisma, tx, order } = makePrisma();

    await withCampaignRowLock(prisma as any, campaignRow.id, async (lockedTx, campaign) => {
      order.push('callback');
      expect(lockedTx).toBe(tx);
      expect(campaign.id).toBe(campaignRow.id);
      return 'done';
    });

    expect(order).toEqual(['begin', 'lock-campaign', 'read-campaign', 'callback', 'commit']);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), COMBAT_STATE_TX_OPTIONS);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('locks and reads Campaign then Map before a token JSON mutation callback', async () => {
    const { prisma, tx, order } = makePrisma();

    const result = await withCampaignMapRowLock(prisma as any, campaignRow.id, mapRow.id, async (lockedTx, campaign, map) => {
      order.push('callback');
      expect(lockedTx).toBe(tx);
      expect(campaign.id).toBe(campaignRow.id);
      expect(map.id).toBe(mapRow.id);
      return 7;
    });

    expect(result).toBe(7);
    expect(order).toEqual([
      'begin', 'lock-campaign', 'read-campaign', 'lock-map', 'read-map', 'callback', 'commit',
    ]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('exposes the same Campaign → Map locking helper for an existing transaction', async () => {
    const { prisma: _prisma, tx, order } = makePrisma();

    const rows = await lockCampaignMapRows(tx as any, campaignRow.id, mapRow.id);

    expect(rows.campaign.id).toBe(campaignRow.id);
    expect(rows.map.id).toBe(mapRow.id);
    expect(order).toEqual(['lock-campaign', 'read-campaign', 'lock-map', 'read-map']);
  });

  it('restores combat state from persisted Campaign JSON on a fresh read', async () => {
    const { prisma } = makePrisma();
    campaignRow.combatState = savedState as unknown as Prisma.JsonValue;

    const stateAfterRestart = await loadCampaignCombatState(prisma as any, campaignRow.id);

    expect(stateAfterRestart).toEqual(savedState);
  });

  it('writes the complete state or clears the nullable column inside the locked transaction', async () => {
    const { prisma, tx } = makePrisma();
    const { remainingMovementFeet: _derived, ...persistedMovement } = savedState.movement!;

    await withCampaignRowLock(prisma as any, campaignRow.id, async (lockedTx) => {
      await saveCampaignCombatState(lockedTx, campaignRow.id, savedState);
    });

    expect(tx.campaign.update).toHaveBeenCalledWith({
      where: { id: campaignRow.id },
      data: { combatState: { ...savedState, movement: persistedMovement } },
    });

    await withCampaignRowLock(prisma as any, campaignRow.id, async (lockedTx) => {
      await saveCampaignCombatState(lockedTx, campaignRow.id, null);
    });
    expect(tx.campaign.update).toHaveBeenLastCalledWith({
      where: { id: campaignRow.id },
      data: { combatState: Prisma.DbNull },
    });
  });

  it('defaults missing persisted state to an inactive combat', async () => {
    const { prisma } = makePrisma();
    campaignRow.combatState = null;

    await expect(loadCampaignCombatState(prisma as any, campaignRow.id)).resolves.toEqual(defaultCombatState());
  });
});
