import { Prisma, PrismaClient } from '@prisma/client';
import type { Campaign, Map as GameMap } from '@prisma/client';
import type { CombatState } from '../websocket/initiativeState';
import { readCombatState } from '../websocket/initiativeState';

export type CombatStateTx = Prisma.TransactionClient;

export const COMBAT_STATE_TX_OPTIONS = { maxWait: 5000, timeout: 10000 } as const;

export class CampaignRowNotFoundError extends Error {
  constructor(campaignId: string) {
    super(`Campaign not found: ${campaignId}`);
    this.name = 'CampaignRowNotFoundError';
  }
}

export class MapRowNotFoundError extends Error {
  constructor(mapId: string, campaignId: string) {
    super(`Map ${mapId} not found in campaign ${campaignId}`);
    this.name = 'MapRowNotFoundError';
  }
}

/** Lock and read a Campaign row. Call before locking a Map row. */
export async function lockCampaignRow(tx: CombatStateTx, campaignId: string): Promise<Campaign> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Campaign" WHERE "id" = ${campaignId} FOR UPDATE
  `;
  if (rows.length === 0) throw new CampaignRowNotFoundError(campaignId);

  const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new CampaignRowNotFoundError(campaignId);
  return campaign;
}

/** Lock Campaign, then its Map, and read both rows after taking the locks. */
export async function lockCampaignMapRows(
  tx: CombatStateTx,
  campaignId: string,
  mapId: string
): Promise<{ campaign: Campaign; map: GameMap }> {
  const campaign = await lockCampaignRow(tx, campaignId);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Map" WHERE "id" = ${mapId} AND "campaignId" = ${campaignId} FOR UPDATE
  `;
  if (rows.length === 0) throw new MapRowNotFoundError(mapId, campaignId);

  const map = await tx.map.findFirst({ where: { id: mapId, campaignId } });
  if (!map) throw new MapRowNotFoundError(mapId, campaignId);
  return { campaign, map };
}

export async function withCampaignRowLock<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  campaignId: string,
  fn: (tx: CombatStateTx, campaign: Campaign) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const campaign = await lockCampaignRow(tx, campaignId);
    return fn(tx, campaign);
  }, COMBAT_STATE_TX_OPTIONS);
}

export async function withCampaignMapRowLock<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  campaignId: string,
  mapId: string,
  fn: (tx: CombatStateTx, campaign: Campaign, map: GameMap) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const { campaign, map } = await lockCampaignMapRows(tx, campaignId, mapId);
    return fn(tx, campaign, map);
  }, COMBAT_STATE_TX_OPTIONS);
}

function toPersistedState(state: CombatState): Prisma.InputJsonValue {
  const movement = state.movement
    ? (({ remainingMovementFeet: _remainingMovementFeet, ...ledger }) => ledger)(state.movement)
    : null;
  return { ...state, movement } as unknown as Prisma.InputJsonValue;
}

/** Store the full public state while the caller holds the Campaign row lock. */
export async function saveCampaignCombatState(
  tx: CombatStateTx,
  campaignId: string,
  state: CombatState | null
): Promise<void> {
  await tx.campaign.update({
    where: { id: campaignId },
    data: { combatState: state === null ? Prisma.DbNull : toPersistedState(state) },
  });
}

/** Fresh database read; there is no process-local initiative cache to restore. */
export async function loadCampaignCombatState(
  prisma: Pick<PrismaClient, 'campaign'>,
  campaignId: string
): Promise<CombatState> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { combatState: true },
  });
  return readCombatState(campaign?.combatState);
}
