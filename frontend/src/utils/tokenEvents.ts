// ============================================
// Token events — live token add / update / remove
//
// The backend broadcasts these after the token REST routes write the map
// (e.g. a DM or an AI game master adding or removing a token). The server
// already filters per recipient: hidden tokens reach DMs only, and a player
// receives `token.removed` / `token.added` when a token's visibility flips.
// ============================================

import type { Token } from '@/types';

/** `token.added` payload — a token the recipient can now see. */
export interface TokenAddedPayload {
  mapId: string;
  token: Token;
}

/** `token.updated` payload — the full token after the update. */
export interface TokenUpdatedPayload {
  mapId: string;
  token: Token;
}

/** `token.removed` payload — the token left the map (or the recipient's view). */
export interface TokenRemovedPayload {
  mapId: string;
  tokenId: string;
}

export type TokenEvent =
  | ({ type: 'token.added' } & TokenAddedPayload)
  | ({ type: 'token.updated' } & TokenUpdatedPayload)
  | ({ type: 'token.removed' } & TokenRemovedPayload);

/** Replace the token with the same id in place, or append it if unknown. */
function upsertToken(tokens: Token[], token: Token): Token[] {
  const index = tokens.findIndex((t) => t.id === token.id);
  if (index === -1) return [...tokens, token];
  const next = [...tokens];
  next[index] = token;
  return next;
}

/**
 * Apply a token event to a token list and return the new list (pure; the
 * input is never mutated).
 *
 * - `token.added` / `token.updated`: replace the token with the same id in
 *   place, or append it if the list does not have it yet (an add echoed back
 *   to the client that already added it optimistically is not duplicated).
 * - `token.removed`: drop the token with that id.
 *
 * The reducer ignores `mapId` on purpose — the caller must drop events for
 * any map other than the one it displays before calling it.
 */
export function applyTokenEvent(tokens: Token[], event: TokenEvent): Token[] {
  switch (event.type) {
    case 'token.added':
    case 'token.updated':
      return upsertToken(tokens, event.token);
    case 'token.removed':
      return tokens.filter((t) => t.id !== event.tokenId);
    default:
      return tokens;
  }
}
