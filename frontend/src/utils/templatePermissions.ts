/**
 * templatePermissions.ts
 * Who may edit or delete a character template.
 *
 * This mirrors the server rule in backend/src/routes/characterTemplates.ts. It
 * exists to decide whether to *render* a control — the API is what actually
 * enforces the rule, and a client that skipped this check would still be
 * refused. Keeping it in one tested function stops the two drifting apart
 * quietly, which is how a UI ends up offering a button that always fails.
 */

import { PlatformRole, type User } from '@/types';

/** The fields of a template this decision depends on. */
export interface TemplateOwnership {
  createdById: string | null;
}

/**
 * True when this user may edit or delete this template.
 *
 * The author always may. Otherwise an admin or a template editor may, which is
 * what allows curation of what other people have published.
 */
export function canModifyTemplate(
  user: Pick<User, 'id' | 'platformRole' | 'templateEditor'> | null | undefined,
  template: TemplateOwnership
): boolean {
  if (!user) return false;

  // An orphaned template — its author's account was deleted — is curator-only.
  if (template.createdById !== null && template.createdById === user.id) return true;

  if (user.platformRole === PlatformRole.ADMIN) return true;

  return user.templateEditor === true;
}
