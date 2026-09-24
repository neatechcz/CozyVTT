import { describe, expect, it } from 'vitest';
import {
  CampaignRole,
  CampaignStatus,
  PlatformRole,
  type Campaign,
  type CampaignMembership,
  type Character,
  type User,
} from '../types';
import {
  canDeleteCampaign,
  canEditCharacter,
  canManageDmRoles,
  canRemoveCampaignMember,
  canRollAsCharacter,
  isCampaignDm,
} from './permissions';

function makeUser(id: string, platformRole = PlatformRole.USER): User {
  return {
    id,
    email: `${id}@example.test`,
    displayName: id,
    platformRole,
    globalAssetManager: false,
    mfaEnabled: false,
    avatarUrl: null,
    bio: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    lastLoginAt: null,
  };
}

function makeMembership(
  userId: string,
  role: CampaignRole,
): CampaignMembership {
  return {
    id: `membership-${userId}`,
    campaignId: 'campaign-1',
    userId,
    role,
    characterIds: [],
    joinedAt: '2026-07-29T00:00:00.000Z',
  };
}

const owner = makeUser('owner');
const coDm = makeUser('co-dm');
const player = makeUser('player');
const admin = makeUser('admin', PlatformRole.ADMIN);
const ownerMembership = makeMembership(owner.id, CampaignRole.DM);
const coDmMembership = makeMembership(coDm.id, CampaignRole.DM);
const playerMembership = makeMembership(player.id, CampaignRole.PLAYER);

const campaign = {
  id: 'campaign-1',
  name: 'Multiple DM Test',
  description: null,
  ownerId: owner.id,
  gameSystem: null,
  status: CampaignStatus.ACTIVE,
  currentMapId: null,
  vibeSettings: { periods: [] },
  currentVibe: null,
  spiritLayerEnabled: false,
  spiritLayerStyle: 'wispy',
  chatCooldownEnabled: false,
  chatCooldownSeconds: 5,
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
  lastPlayedAt: null,
  memberships: [ownerMembership, coDmMembership, playerMembership],
} satisfies Campaign;

describe('campaign DM permissions', () => {
  it('recognizes a co-DM from campaign membership', () => {
    expect(isCampaignDm(campaign, coDm.id)).toBe(true);
  });

  it('does not infer DM role from ownerId without a DM membership', () => {
    expect(
      isCampaignDm(
        { ...campaign, memberships: [coDmMembership, playerMembership] },
        owner.id,
      ),
    ).toBe(false);
  });

  it('lets only the owner or platform admin manage DM roles', () => {
    expect(canManageDmRoles(campaign, owner)).toBe(true);
    expect(canManageDmRoles(campaign, coDm)).toBe(false);
    expect(canManageDmRoles(campaign, admin)).toBe(true);
  });

  it('lets only the owner or platform admin delete the campaign', () => {
    expect(canDeleteCampaign(campaign, coDm)).toBe(false);
    expect(canDeleteCampaign(campaign, owner)).toBe(true);
    expect(canDeleteCampaign(campaign, admin)).toBe(true);
  });

  it('lets the owner remove a co-DM but never the owner membership', () => {
    expect(canRemoveCampaignMember(campaign, owner, coDmMembership)).toBe(true);
    expect(canRemoveCampaignMember(campaign, owner, ownerMembership)).toBe(false);
  });

  it('lets a co-DM remove a player but not another DM', () => {
    expect(canRemoveCampaignMember(campaign, coDm, playerMembership)).toBe(true);
    expect(canRemoveCampaignMember(campaign, coDm, ownerMembership)).toBe(false);
    expect(canRemoveCampaignMember(campaign, coDm, coDmMembership)).toBe(false);
  });
});

describe('delegated character access', () => {
  const character = { id: 'mich', userId: 'mcp-owner' } as Character;

  it('lets only the assigned player edit an MCP-owned character', () => {
    expect(canEditCharacter(player, character, { ...playerMembership, characterIds: ['mich'] })).toBe(true);
    expect(canEditCharacter(player, character, playerMembership)).toBe(false);
    expect(canEditCharacter(player, character, { ...playerMembership, role: CampaignRole.SPECTATOR, characterIds: ['mich'] })).toBe(false);
    expect(canEditCharacter(coDm, character, coDmMembership)).toBe(true);
  });

  it('offers sheet rolls to the owner, DM and assigned player only', () => {
    expect(canRollAsCharacter(player, character, { ...playerMembership, characterIds: ['mich'] })).toBe(true);
    expect(canRollAsCharacter(player, character, playerMembership)).toBe(false);
    expect(canRollAsCharacter(coDm, character, coDmMembership)).toBe(true);
    expect(canRollAsCharacter({ ...player, id: 'mcp-owner' }, character)).toBe(true);
  });
});
