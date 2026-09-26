import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Character Row Lock
 * Every writer of `Character.data` (PUT, PATCH, the HP socket handler) runs
 * its read → modify → write inside one transaction that first takes a
 * `SELECT … FOR UPDATE` lock on the character row. Concurrent writers are
 * therefore serialised and each one reads the previous writer's result.
 * The table name is the model name: `Character` has no @@map.
 */

export type CharacterTx = Prisma.TransactionClient;

/**
 * Explicit interactive-transaction limits (Prisma defaults: maxWait 2 s,
 * timeout 5 s): time to get a connection, and time the locked
 * read → modify → write (including the wait for another writer's lock) may take.
 */
export const CHARACTER_LOCK_TX_OPTIONS = { maxWait: 5000, timeout: 10000 } as const;

/** Prisma: the interactive transaction could not start in time or timed out */
const PRISMA_TRANSACTION_TIMEOUT = 'P2028';

export const CHARACTER_BUSY_MESSAGE = 'Character is busy, retry shortly';

/** True for a Prisma transaction maxWait / timeout error (P2028) — a busy row, not a bug. */
export function isCharacterLockTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PRISMA_TRANSACTION_TIMEOUT
  );
}

export async function withCharacterRowLock<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  characterId: string,
  fn: (tx: CharacterTx) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Character" WHERE "id" = ${characterId} FOR UPDATE`;
    return fn(tx);
  }, CHARACTER_LOCK_TX_OPTIONS);
}
