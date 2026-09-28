/**
 * A restore has to be all or nothing.
 *
 * The dump a backup contains drops every table before recreating it, so the two
 * flags asserted here are what stand between a corrupt backup file and an
 * instance with no data in it. They were missing, and a failed restore reported
 * success.
 */

import { buildRestoreArgs } from './pgRestore';

describe('buildRestoreArgs', () => {
  const args = buildRestoreArgs('postgresql://u:p@h:5432/db', '/tmp/backup/database.sql');

  it('names the database and the file to restore', () => {
    expect(args).toEqual(
      expect.arrayContaining(['--dbname', 'postgresql://u:p@h:5432/db', '--file', '/tmp/backup/database.sql'])
    );
  });

  it('stops at the first failing statement', () => {
    // Without this psql runs the rest of the dump after an error and still
    // exits 0, so the caller cannot tell a failed restore from a good one.
    const i = args.indexOf('-v');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('ON_ERROR_STOP=1');
  });

  it('runs the whole restore in one transaction', () => {
    // So a failure rolls the drops back instead of leaving the tables gone.
    expect(args).toContain('--single-transaction');
  });
});
