/**
 * Permission Utilities
 */

import { PlatformRole } from '../types';
import type {
  User,
  Character,
  Campaign,
  CampaignMembership,
} from '../types';

export function isCampaignDm(campaign: Campaign, userId: string): boolean {
  return (
    campaign.memberships?.some(
      (membership) =>
        membership.userId === userId && membership.role === 'DM',
    ) ?? false
  );
}

export function canManageDmRoles(campaign: Campaign, user: User): boolean {
  return (
    user.platformRole === PlatformRole.ADMIN || campaign.ownerId === user.id
  );
}

export function canDeleteCampaign(campaign: Campaign, user: User): boolean {
  return canManageDmRoles(campaign, user);
}

export function canRemoveCampaignMember(
  campaign: Campaign,
  user: User,
  membership: CampaignMembership,
): boolean {
  if (membership.userId === campaign.ownerId) {
    return false;
  }

  if (membership.role === 'DM') {
    return canManageDmRoles(campaign, user);
  }

  return canManageDmRoles(campaign, user) || isCampaignDm(campaign, user.id);
}

/**
 * Check if a user can edit a character
 * @param user - Current user
 * @param character - Character to edit
 * @param membership - User's campaign membership (if viewing in campaign context)
 * @returns true if user can edit the character
 */
export function canEditCharacter(
  user: User,
  character: Pick<Character, 'id' | 'userId'>,
  membership?: CampaignMembership
): boolean {
  // User owns the character
  if (character.userId === user.id) {
    return true;
  }

  // User is DM of the campaign
  if (membership && membership.role === 'DM') {
    return true;
  }

  if (membership?.role === 'PLAYER' && membership.characterIds.includes(character.id)) {
    return true;
  }

  return false;
}

/**
 * Check if a user can view a character
 * In campaign context, DMs and assigned players can view full sheets
 * @param user - Current user
 * @param character - Character to view
 * @param membership - User's campaign membership (if in campaign context)
 * @returns true if user can view the character
 */
export function canViewCharacter(
  user: User,
  character: Pick<Character, 'id' | 'userId'>,
  membership?: CampaignMembership
): boolean {
  // User owns the character
  if (character.userId === user.id) {
    return true;
  }

  return membership?.role === 'DM' ||
    (membership?.role === 'PLAYER' && membership.characterIds.includes(character.id)) || false;
}

/** Character-based rolls use the sheet's modifiers and require control. */
export function canRollAsCharacter(
  user: User,
  character: Pick<Character, 'id' | 'userId'>,
  membership?: CampaignMembership
): boolean {
  return character.userId === user.id || membership?.role === 'DM' ||
    (membership?.role === 'PLAYER' && membership.characterIds.includes(character.id)) || false;
}

/**
 * Check if a user can reassign a character to another player
 * Only DMs can reassign characters
 * @param membership - User's campaign membership
 * @returns true if user can reassign characters
 */
export function canReassignCharacter(membership?: CampaignMembership): boolean {
  return membership?.role === 'DM';
}

/**
 * Check if a user can remove a character from a campaign
 * Character owners and DMs can remove characters
 * @param user - Current user
 * @param character - Character to remove
 * @param membership - User's campaign membership
 * @returns true if user can remove the character
 */
export function canRemoveCharacterFromCampaign(
  user: User,
  character: Character,
  membership?: CampaignMembership
): boolean {
  // User owns the character
  if (character.userId === user.id) {
    return true;
  }

  // User is DM
  if (membership?.role === 'DM') {
    return true;
  }

  return false;
}
