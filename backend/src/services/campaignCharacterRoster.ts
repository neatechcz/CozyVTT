import type { Prisma } from '@prisma/client';

/** Keep the owner's controller assignment and every DM roster in sync atomically. */
export async function addCharacterToCampaignRosters(
  tx: Prisma.TransactionClient, campaignId: string, ownerId: string, characterId: string
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "CampaignMembership"
    SET "characterIds" = array_append("characterIds", ${characterId}::text)
    WHERE "campaignId" = ${campaignId}
      AND ("userId" = ${ownerId} OR "role" = 'DM')
      AND NOT (${characterId}::text = ANY("characterIds"))
  `;
}

/** Remove a departed character from DM and delegated-player assignments alike. */
export async function removeCharacterFromCampaignRosters(
  tx: Prisma.TransactionClient, campaignId: string, characterId: string
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "CampaignMembership"
    SET "characterIds" = array_remove("characterIds", ${characterId}::text)
    WHERE "campaignId" = ${campaignId}
      AND ${characterId}::text = ANY("characterIds")
  `;
}
