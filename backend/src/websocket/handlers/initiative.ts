// ============================================
// Initiative tracker handlers.
// Every mutation locks and persists Campaign.combatState. Writes that also
// update Map.tokens lock Campaign first and Map second.
// ============================================

import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { AuthenticatedSocket } from '../auth';
import { prisma } from '../../config/database';
import { rollDice, parseDiceExpression, DiceParserError } from '../../utils/dice-parser';
import {
  resolveCharacterInitiative,
  resolveStatBlockInitiative,
  DEFAULT_INITIATIVE_EXPRESSION,
} from '../../utils/rules/initiative';
import logger from '../../utils/logger';
import { dnd5eExhaustionLevel } from '../../utils/dnd5eExhaustion';
import {
  readCombatState,
  defaultCombatState,
  sortCombatants,
  type CombatantEntry,
  type CombatState,
  type MovementLedger,
} from '../initiativeState';
import {
  withCampaignRowLock,
  withCampaignMapRowLock,
  loadCampaignCombatState,
  saveCampaignCombatState,
  type CombatStateTx,
} from '../../services/combatStatePersistence';
import { resolveDnd5eMovementSpeed, type MovementSpeedActor } from '../../services/combatMovement';
import { bumpMapVersion } from '../mapVersion';

interface InitiativeToken {
  id: string;
  characterId?: string | null;
  creatureTemplateId?: string | null;
  name: string;
  imageUrl?: string | null;
  initiative?: number | null;
  hp?: { current: number; max: number; temp?: number } | null;
  type?: 'player' | 'npc' | 'object';
  disposition?: 'friendly' | 'neutral' | 'hostile' | null;
  controlledBy?: string | null;
  conditions?: unknown;
  statBlock?: unknown;
}

type MutationResult<T> = { ok: true; value: T } | { ok: false; message: string };

function error(message: string): MutationResult<never> {
  return { ok: false, message };
}

function tokenArray(value: unknown): InitiativeToken[] {
  return Array.isArray(value) ? value.filter((item): item is InitiativeToken =>
    typeof item === 'object' && item !== null && typeof (item as InitiativeToken).id === 'string'
  ) : [];
}

function asCombatant(token: InitiativeToken): CombatantEntry {
  return {
    tokenId: token.id,
    name: token.name,
    imageUrl: token.imageUrl || '',
    initiative: token.initiative ?? null,
    hp: token.hp ? { current: token.hp.current, max: token.hp.max, temp: token.hp.temp ?? 0 } : null,
    type: token.type ?? 'npc',
    disposition: token.disposition ?? null,
  };
}

function validateMapForCombat(state: CombatState, mapId: string): string | null {
  if (state.active && state.mapId !== mapId) return 'Active combat is on a different map';
  if (state.combatants.length > 0 && state.mapId !== mapId) return 'All combatants must be on the same map';
  return null;
}

function movementLedger(tokenId: string, turnId: string, speedFeet: number | null): MovementLedger {
  return {
    tokenId,
    turnId,
    speedFeet,
    spentFeet: 0,
    dashBonusFeet: 0,
    dashUsed: false,
    diagonalStepsTaken: 0,
    remainingMovementFeet: speedFeet,
  };
}

function updateRemainingMovement(ledger: MovementLedger): MovementLedger {
  return {
    ...ledger,
    remainingMovementFeet: ledger.speedFeet === null
      ? null
      : Math.max(0, ledger.speedFeet + ledger.dashBonusFeet - ledger.spentFeet),
  };
}

function movementSpeedFailure(resolution: { ok: false; error: { code: string; message?: string } }): string {
  return resolution.error.message ?? `Movement speed could not be resolved (${resolution.error.code})`;
}

async function resolveActiveActorSpeed(
  tx: CombatStateTx,
  campaign: { id: string; gameSystem: string | null },
  mapId: string,
  tokenId: string,
  tokenRows?: InitiativeToken[]
): Promise<{ ok: true; speedFeet: number } | { ok: false; message: string }> {
  const tokens = tokenRows ?? tokenArray((await tx.map.findFirst({
    where: { id: mapId, campaignId: campaign.id },
    select: { tokens: true },
  }))?.tokens);
  const token = tokens.find((entry) => entry.id === tokenId);
  if (!token) return { ok: false, message: 'Active combatant token not found on the combat map' };
  if (campaign.gameSystem !== null && campaign.gameSystem !== 'DND_5E') {
    return { ok: false, message: 'Dash movement is only supported for D&D 5e combat' };
  }

  let actor: MovementSpeedActor;
  let linkedGameSystem: string | null = null;
  if (token.characterId) {
    const character = await tx.character.findFirst({
      where: { id: token.characterId, campaignId: campaign.id },
      select: { gameSystem: true, data: true },
    });
    if (!character) return { ok: false, message: 'The active token’s linked character could not be found' };
    linkedGameSystem = character.gameSystem;
    actor = { kind: 'pc', characterData: character.data };
  } else {
    let templateGameSystem: string | null = null;
    let templateStatBlock: unknown = null;
    if (token.creatureTemplateId) {
      const template = await tx.creatureTemplate.findUnique({
        where: { id: token.creatureTemplateId },
        select: { gameSystem: true, statBlock: true },
      });
      templateGameSystem = template?.gameSystem ?? null;
      templateStatBlock = template?.statBlock ?? null;
    }
    linkedGameSystem = templateGameSystem;
    actor = {
      kind: 'npc',
      statBlock: token.statBlock ?? templateStatBlock,
      conditions: Array.isArray(token.conditions) ? token.conditions : [],
    };
  }

  // Legacy campaigns may have a null gameSystem. For those, require a linked
  // character or creature template to identify the actor's actual ruleset.
  if (campaign.gameSystem === null && linkedGameSystem !== 'DND_5E') {
    return { ok: false, message: 'The active combatant ruleset cannot be identified as D&D 5e' };
  }
  if (campaign.gameSystem !== null && linkedGameSystem !== null && campaign.gameSystem !== linkedGameSystem) {
    return { ok: false, message: 'The active combatant ruleset does not match the campaign' };
  }

  const speed = resolveDnd5eMovementSpeed(actor);
  if (!speed.ok) return { ok: false, message: movementSpeedFailure(speed) };
  return { ok: true, speedFeet: speed.speedFeet };
}

async function setActiveTurn(
  tx: CombatStateTx,
  campaign: { id: string; gameSystem: string | null },
  state: CombatState,
  tokenId: string,
  tokenRows?: InitiativeToken[]
): Promise<void> {
  const turnId = randomUUID();
  state.currentTokenId = tokenId;
  state.turnId = turnId;
  if (!state.mapId) {
    state.movement = null;
    return;
  }
  const speed = await resolveActiveActorSpeed(tx, campaign, state.mapId, tokenId, tokenRows);
  state.movement = movementLedger(tokenId, turnId, speed.ok ? speed.speedFeet : null);
}

function isDm(socket: AuthenticatedSocket, action: string): boolean {
  if (!socket.campaignId) {
    socket.emit('error', { message: 'Not authenticated to a campaign' });
    return false;
  }
  if (socket.role !== 'DM') {
    socket.emit('error', { message: `Only the DM can ${action}` });
    return false;
  }
  return true;
}

export function registerInitiativeHandlers(io: Server, socket: AuthenticatedSocket): void {
  async function broadcastInitiativeState(campaignId: string): Promise<void> {
    const state = await loadCampaignCombatState(prisma, campaignId);
    io.to(campaignId).emit('initiative.state', state);
  }

  /** DM adds a token to the single-map initiative list. */
  socket.on('initiative.add', async (data: { tokenId: string; mapId: string }) => {
    try {
      if (!isDm(socket, 'modify initiative')) return;
      const { tokenId, mapId } = data;
      if (!tokenId || !mapId) { socket.emit('error', { message: 'tokenId and mapId required' }); return; }

      const result = await withCampaignMapRowLock(prisma, socket.campaignId!, mapId, async (tx, campaign, map) => {
        const state = readCombatState(campaign.combatState);
        const mapError = validateMapForCombat(state, mapId);
        if (mapError) return error(mapError);
        const token = tokenArray(map.tokens).find((entry) => entry.id === tokenId);
        if (!token) return error('Token not found');
        if (state.combatants.some((entry) => entry.tokenId === tokenId)) return error('Token is already in initiative');

        state.mapId = mapId;
        state.combatants = sortCombatants([...state.combatants, { ...asCombatant(token), initiative: null }]);
        await saveCampaignCombatState(tx, campaign.id, state);
        return { ok: true, value: state } as const;
      });
      if (!result.ok) { socket.emit('error', { message: result.message }); return; }
      await broadcastInitiativeState(socket.campaignId!);
      logger.debug('initiative.add', { tokenId, campaignId: socket.campaignId });
    } catch (err) {
      logger.error('initiative.add failed', { err });

      socket.emit('error', { message: 'Failed to add to initiative' });
    }
  });

  /** DM removes a combatant; removing the actor advances and resets its turn ledger. */
  socket.on('initiative.remove', async (data: { tokenId: string }) => {
    try {
      if (!isDm(socket, 'modify initiative')) return;
      const { tokenId } = data;
      if (!tokenId) { socket.emit('error', { message: 'tokenId required' }); return; }

      const state = await withCampaignRowLock(prisma, socket.campaignId!, async (tx, campaign) => {
        const current = readCombatState(campaign.combatState);
        const oldCurrentIndex = current.combatants.findIndex((entry) => entry.tokenId === current.currentTokenId);
        current.combatants = current.combatants.filter((entry) => entry.tokenId !== tokenId);

        if (current.combatants.length === 0) {
          const inactive = defaultCombatState();
          await saveCampaignCombatState(tx, campaign.id, inactive);
          return inactive;
        }

        if (current.active && current.currentTokenId === tokenId) {
          const nextIndex = oldCurrentIndex < 0 ? 0 : Math.min(oldCurrentIndex, current.combatants.length - 1);
          if (oldCurrentIndex >= current.combatants.length) current.round += 1;
          const nextTokenId = current.combatants[nextIndex].tokenId;
          await setActiveTurn(tx, campaign, current, nextTokenId);
        }

        await saveCampaignCombatState(tx, campaign.id, current);
        return current;
      });
      await broadcastInitiativeState(socket.campaignId!);
      logger.debug('initiative.remove', { tokenId, campaignId: socket.campaignId, active: state.active });
    } catch (err) {
      logger.error('initiative.remove failed', { err });
      socket.emit('error', { message: 'Failed to remove from initiative' });
    }
  });

  /** DM manually sets a token's initiative value and persists token/state atomically. */
  socket.on('initiative.set', async (data: { tokenId: string; mapId: string; value: number | null }) => {
    try {
      if (!isDm(socket, 'modify initiative')) return;
      const { tokenId, mapId, value } = data;
      if (!tokenId || !mapId) { socket.emit('error', { message: 'tokenId and mapId required' }); return; }
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        socket.emit('error', { message: 'value must be a finite number or null' }); return;

      }

      const result = await withCampaignMapRowLock(prisma, socket.campaignId!, mapId, async (tx, campaign, map) => {
        const state = readCombatState(campaign.combatState);
        const mapError = validateMapForCombat(state, mapId);
        if (mapError) return error(mapError);
        const tokens = tokenArray(map.tokens);
        const index = tokens.findIndex((entry) => entry.id === tokenId);
        if (index === -1) return error('Token not found');
        const token = tokens[index];
        tokens[index] = { ...token, initiative: value };
        const combatantIndex = state.combatants.findIndex((entry) => entry.tokenId === tokenId);
        if (combatantIndex !== -1) {
          state.combatants[combatantIndex] = { ...state.combatants[combatantIndex], initiative: value };
          state.combatants = sortCombatants(state.combatants);
        }
        await tx.map.update({ where: { id: mapId }, data: { tokens: tokens as any } });
        await saveCampaignCombatState(tx, campaign.id, state);
        return { ok: true, value: state } as const;
      });
      if (!result.ok) { socket.emit('error', { message: result.message }); return; }
      bumpMapVersion(mapId);
      await broadcastInitiativeState(socket.campaignId!);
      logger.debug('initiative.set', { tokenId, value, campaignId: socket.campaignId });
    } catch (err) {
      logger.error('initiative.set failed', { err });
      socket.emit('error', { message: 'Failed to set initiative value' });
    }
  });

  /** Derive system initiative; a DM may supply an explicit adjudicated expression. */
  socket.on('initiative.roll', async (data: { tokenId: string; mapId: string; expression?: string; characterName?: string }) => {
    try {
      if (!socket.campaignId) { socket.emit('error', { message: 'Not authenticated to a campaign' }); return; }
      const { tokenId, mapId, expression, characterName } = data;
      if (!tokenId || !mapId) { socket.emit('error', { message: 'tokenId and mapId required' }); return; }
      try { if (expression !== undefined) parseDiceExpression(expression); } catch (err) {
        if (err instanceof DiceParserError) { socket.emit('error', { message: `Invalid expression: ${err.message}` }); return; }
        throw err;
      }

      const result = await withCampaignMapRowLock(prisma, socket.campaignId!, mapId, async (tx, campaign, map) => {
        const state = readCombatState(campaign.combatState);
        const mapError = validateMapForCombat(state, mapId);
        if (mapError) return error(mapError);
        const tokens = tokenArray(map.tokens);
        const tokenIndex = tokens.findIndex((entry) => entry.id === tokenId);
        if (tokenIndex === -1) return error('Token not found');
        const token = tokens[tokenIndex];
        const existingIndex = state.combatants.findIndex((entry) => entry.tokenId === tokenId);
        if (socket.role !== 'DM') {
          if (socket.role === 'SPECTATOR') return error('Spectators cannot roll initiative');
          if (token.controlledBy !== socket.userId) return error('You can only roll initiative for your own token');
          if (existingIndex === -1) return error('That token is not in the initiative order yet');
          if (state.active) return error('Combat has started — ask your DM to change your initiative');
        }

        // Derive initiative from the authoritative sheet while both campaign
        // and map remain locked. A player's expression never supplies a bonus.
        let resolution = null as ReturnType<typeof resolveCharacterInitiative>;
        let exhaustedAbilityCheck = false;
        if (token.characterId) {
          const character = await tx.character.findFirst({
            where: { id: token.characterId, campaignId: campaign.id },
            select: { gameSystem: true, data: true },
          });
          if (character) {
            resolution = resolveCharacterInitiative(character.gameSystem, character.data);
            exhaustedAbilityCheck = character.gameSystem === 'DND_5E'
              && dnd5eExhaustionLevel(character.data as Record<string, unknown>) >= 1;
          }
        }
        if (!resolution && token.statBlock) {
          resolution = resolveStatBlockInitiative(campaign.gameSystem, token.statBlock);
        }
        let usedExpression = '';
        let rollResult: ReturnType<typeof rollDice> | null = null;
        let rolledValue: number;
        // DM expressions are explicit adjudication (including MCP advantage,
        // disadvantage and situational bonuses); omitted expressions derive defaults.
        const dmExpression = socket.role === 'DM' ? expression : undefined;
        if (!dmExpression && resolution?.kind === 'fixed') {
          rolledValue = resolution.value;
        } else {
          usedExpression = dmExpression ?? (resolution?.kind === 'roll' ? resolution.expression : DEFAULT_INITIATIVE_EXPRESSION);
          if (!dmExpression && exhaustedAbilityCheck) usedExpression = usedExpression.replace(/^1d20/, '2d20kl1');
          try { parseDiceExpression(usedExpression); } catch {
            logger.warn('initiative.roll derived an unparseable expression', { usedExpression, campaignId: campaign.id });
            usedExpression = DEFAULT_INITIATIVE_EXPRESSION;
          }
          rollResult = rollDice(usedExpression);
          rolledValue = rollResult.total;
        }
        tokens[tokenIndex] = { ...token, initiative: rolledValue };
        if (existingIndex !== -1) {
          state.combatants[existingIndex] = { ...state.combatants[existingIndex], initiative: rolledValue };
        } else {
          state.mapId = mapId;
          state.combatants.push(asCombatant(tokens[tokenIndex]));
        }
        state.combatants = sortCombatants(state.combatants);
        await tx.map.update({ where: { id: mapId }, data: { tokens: tokens as any } });
        await saveCampaignCombatState(tx, campaign.id, state);
        return { ok: true, value: { state, tokenName: token.name, rollResult, rolledValue, usedExpression } } as const;
      });
      if (!result.ok) { socket.emit('error', { message: result.message }); return; }

      bumpMapVersion(mapId);
      const { rollResult, rolledValue, usedExpression } = result.value;
      const user = await prisma.user.findUnique({ where: { id: socket.userId }, select: { displayName: true } });
      if (rollResult) io.to(socket.campaignId!).emit('dice.rolled', {
        userId: socket.userId,
        userName: user?.displayName ?? 'DM',
        characterName: characterName || result.value.tokenName,
        expression: usedExpression,
        result: rolledValue,
        breakdown: rollResult,
        purpose: `${result.value.tokenName} Initiative`,
        timestamp: new Date().toISOString(),
        secret: false,
      });
      await broadcastInitiativeState(socket.campaignId!);
      logger.debug('initiative.roll', { expression, result: rolledValue, name: result.value.tokenName, campaignId: socket.campaignId });
    } catch (err) {
      logger.error('initiative.roll failed', { err });

      socket.emit('error', { message: 'Failed to roll initiative' });
    }
  });

  /** DM drags combatants into a custom order. */
  socket.on('initiative.reorder', async (data: { orderedTokenIds: string[] }) => {
    try {
      if (!isDm(socket, 'reorder initiative')) return;
      if (!Array.isArray(data.orderedTokenIds)) { socket.emit('error', { message: 'orderedTokenIds must be an array' }); return; }

      await withCampaignRowLock(prisma, socket.campaignId!, async (tx, campaign) => {
        const state = readCombatState(campaign.combatState);
        const combatantMap = new Map(state.combatants.map((entry) => [entry.tokenId, entry]));
        const reordered: CombatantEntry[] = [];
        for (const id of data.orderedTokenIds) {
          const entry = combatantMap.get(id);
          if (entry && !reordered.includes(entry)) reordered.push(entry);
        }
        for (const entry of state.combatants) if (!reordered.includes(entry)) reordered.push(entry);
        state.combatants = reordered;
        await saveCampaignCombatState(tx, campaign.id, state);
      });
      await broadcastInitiativeState(socket.campaignId!);
    } catch (err) {
      logger.error('initiative.reorder failed', { err });
      socket.emit('error', { message: 'Failed to reorder initiative' });
    }
  });

  /** DM begins combat with a fresh combat and turn identity. */
  socket.on('initiative.start', async () => {
    try {
      if (!isDm(socket, 'start combat')) return;
      const result = await withCampaignRowLock(prisma, socket.campaignId!, async (tx, campaign) => {
        const state = readCombatState(campaign.combatState);
        if (state.combatants.length === 0) return error('Add combatants before starting combat');
        if (state.active) return error('Combat is already active');
        if (!state.mapId) return error('Combatants must be on a map before starting combat');

        state.active = true;
        state.round = 1;
        state.combatId = randomUUID();
        await setActiveTurn(tx, campaign, state, state.combatants[0].tokenId);
        await saveCampaignCombatState(tx, campaign.id, state);
        return { ok: true, value: state } as const;
      });
      if (!result.ok) { socket.emit('error', { message: result.message }); return; }
      await broadcastInitiativeState(socket.campaignId!);
      logger.info('initiative.start', { campaignId: socket.campaignId, first: result.value.currentTokenId });
    } catch (err) {
      logger.error('initiative.start failed', { err });
      socket.emit('error', { message: 'Failed to start combat' });
    }
  });

  /** DM advances the actor and creates an empty ledger for the new turn. */
  socket.on('initiative.next', async () => {
    try {
      if (!isDm(socket, 'advance the turn')) return;
      const result = await withCampaignRowLock(prisma, socket.campaignId!, async (tx, campaign) => {
        const state = readCombatState(campaign.combatState);
        if (!state.active || state.combatants.length === 0 || !state.combatId) return error('Combat is not active');
        const currentIndex = state.combatants.findIndex((entry) => entry.tokenId === state.currentTokenId);
        const nextIndex = currentIndex < 0 ? 0 : currentIndex + 1;
        if (nextIndex >= state.combatants.length) state.round += 1;
        const nextTokenId = state.combatants[nextIndex >= state.combatants.length ? 0 : nextIndex].tokenId;
        await setActiveTurn(tx, campaign, state, nextTokenId);
        await saveCampaignCombatState(tx, campaign.id, state);
        return { ok: true, value: state } as const;
      });
      if (!result.ok) { socket.emit('error', { message: result.message }); return; }
      await broadcastInitiativeState(socket.campaignId!);
      logger.debug('initiative.next', { round: result.value.round, current: result.value.currentTokenId, campaignId: socket.campaignId });
    } catch (err) {
      logger.error('initiative.next failed', { err });
      socket.emit('error', { message: 'Failed to advance initiative' });
    }
  });

  /** DM ends combat and clears persisted initiative state. */
  socket.on('initiative.end', async () => {
    try {
      if (!isDm(socket, 'end combat')) return;
      await withCampaignRowLock(prisma, socket.campaignId!, async (tx, campaign) => {
        await saveCampaignCombatState(tx, campaign.id, null);
      });
      io.to(socket.campaignId!).emit('initiative.state', defaultCombatState());
      logger.info('initiative.end', { campaignId: socket.campaignId });
    } catch (err) {
      logger.error('initiative.end failed', { err });
      socket.emit('error', { message: 'Failed to end combat' });
    }
  });

  /** The active actor spends its standard action to Dash once during its turn. */
  socket.on('initiative.dash', async (data?: { tokenId?: string }) => {
    try {
      if (!socket.campaignId) { socket.emit('error', { message: 'Not authenticated to a campaign' }); return; }
      const result = await withCampaignRowLock(prisma, socket.campaignId, async (tx, campaign) => {
        const state = readCombatState(campaign.combatState);
        if (!state.active || !state.currentTokenId || !state.turnId || !state.combatId || !state.mapId) {
          return error('Combat is not active');
        }
        if (data?.tokenId && data.tokenId !== state.currentTokenId) return error('Only the active combatant can Dash');
        const tokens = tokenArray((await tx.map.findFirst({
          where: { id: state.mapId, campaignId: campaign.id },
          select: { tokens: true },
        }))?.tokens);
        const token = tokens.find((entry) => entry.id === state.currentTokenId);
        if (!token) return error('Active combatant token not found');
        if (socket.role !== 'DM' && (socket.role === 'SPECTATOR' || token.controlledBy !== socket.userId)) {
          return error('You do not have permission to use the active combatant');
        }
        if (state.movement?.turnId === state.turnId && state.movement.dashUsed) return error('Dash has already been used this turn');

        const speed = await resolveActiveActorSpeed(tx, campaign, state.mapId, state.currentTokenId, tokens);
        if (!speed.ok) return error(speed.message);
        const ledger = state.movement?.turnId === state.turnId && state.movement.tokenId === state.currentTokenId
          ? state.movement
          : movementLedger(state.currentTokenId, state.turnId, speed.speedFeet);
        state.movement = updateRemainingMovement({
          ...ledger,
          speedFeet: speed.speedFeet,
          dashBonusFeet: speed.speedFeet,
          dashUsed: true,
        });
        await saveCampaignCombatState(tx, campaign.id, state);
        return { ok: true, value: state } as const;
      });
      if (!result.ok) { socket.emit('error', { message: result.message }); return; }
      await broadcastInitiativeState(socket.campaignId);
    } catch (err) {
      logger.error('initiative.dash failed', { err });
      socket.emit('error', { message: 'Failed to use Dash' });
    }
  });

  /** Client requests fresh persisted state after (re)connect or process restart. */
  socket.on('initiative.request_state', async () => {
    if (!socket.campaignId) return;
    try {
      const state = await loadCampaignCombatState(prisma, socket.campaignId);
      socket.emit('initiative.state', state);
    } catch (err) {
      logger.error('initiative.request_state failed', { err });
      socket.emit('error', { message: 'Failed to get initiative state' });
    }
  });
}
