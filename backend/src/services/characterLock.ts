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

export async function withCharacterRowLock<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  characterId: string,
  fn: (tx: CharacterTx) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Character" WHERE "id" = ${characterId} FOR UPDATE`;
    return fn(tx);
  });
}
