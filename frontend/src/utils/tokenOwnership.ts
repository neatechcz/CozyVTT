// ============================================
// Token ownership for dynamic lighting
//
// The same rule as the server's isOwnToken (backend/src/utils/spirit-layer.ts):
// a token is the viewer's own when they control it (`controlledBy`), or when
// it is linked (`characterId`) to a character they own or are assigned through
// their campaign membership `characterIds`. Own tokens are the viewer's vision
// sources and are exempt from fog; the server always sends them.
// ============================================

interface OwnershipCampaign {
  characters?: ReadonlyArray<{ id: string; userId: string }>;
  memberships?: ReadonlyArray<{ userId: string; characterIds?: readonly string[] }>;
}

/** Character ids the user owns in the campaign or is assigned through their membership. */
export function getOwnCharacterIds(
  campaign: OwnershipCampaign | null | undefined,
  userId: string | undefined
): Set<string> {
  const ids = new Set<string>();
  if (!campaign || !userId) return ids;
  for (const c of campaign.characters ?? []) if (c.userId === userId) ids.add(c.id);
  for (const m of campaign.memberships ?? []) {
    if (m.userId === userId) for (const id of m.characterIds ?? []) ids.add(id);
  }
  return ids;
}

/** Whether the token is the user's own (see getOwnCharacterIds). */
export function isOwnToken(
  token: { controlledBy?: string | null; characterId?: string | null },
  userId: string | undefined,
  ownCharacterIds: ReadonlySet<string>
): boolean {
  if (!userId) return false;
  if (token.controlledBy === userId) return true;
  return !!(token.characterId && ownCharacterIds.has(token.characterId));
}
