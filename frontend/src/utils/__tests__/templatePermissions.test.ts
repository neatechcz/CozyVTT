import { describe, it, expect } from 'vitest';
import { canModifyTemplate } from '../templatePermissions';
import { PlatformRole, type User } from '@/types';

type Actor = Pick<User, 'id' | 'platformRole' | 'templateEditor'>;

const author: Actor = { id: 'author-1', platformRole: PlatformRole.USER, templateEditor: false };
const stranger: Actor = { id: 'other-1', platformRole: PlatformRole.USER, templateEditor: false };
const editor: Actor = { id: 'editor-1', platformRole: PlatformRole.USER, templateEditor: true };
const admin: Actor = { id: 'admin-1', platformRole: PlatformRole.ADMIN, templateEditor: false };

const owned = { createdById: 'author-1' };
const orphaned = { createdById: null };

describe('canModifyTemplate', () => {
  it('lets the author modify their own', () => {
    expect(canModifyTemplate(author, owned)).toBe(true);
  });

  // The case the whole permission exists to prevent.
  it('refuses an unrelated user', () => {
    expect(canModifyTemplate(stranger, owned)).toBe(false);
  });

  it('lets a template editor modify anyone\'s', () => {
    expect(canModifyTemplate(editor, owned)).toBe(true);
  });

  it('lets an admin modify anyone\'s', () => {
    expect(canModifyTemplate(admin, owned)).toBe(true);
  });

  it('refuses a signed-out visitor', () => {
    expect(canModifyTemplate(null, owned)).toBe(false);
    expect(canModifyTemplate(undefined, owned)).toBe(false);
  });

  describe('a template whose author was deleted', () => {
    // createdById goes null when the account is removed. Nobody should
    // accidentally inherit ownership of it by also having a null id.
    it('is not modifiable by an ordinary user', () => {
      expect(canModifyTemplate(stranger, orphaned)).toBe(false);
      expect(canModifyTemplate(author, orphaned)).toBe(false);
    });

    it('is still modifiable by a curator', () => {
      expect(canModifyTemplate(editor, orphaned)).toBe(true);
      expect(canModifyTemplate(admin, orphaned)).toBe(true);
    });
  });

  it('does not treat a falsy user id as a match', () => {
    const nameless = { id: '', platformRole: PlatformRole.USER, templateEditor: false };
    expect(canModifyTemplate(nameless, orphaned)).toBe(false);
  });
});
