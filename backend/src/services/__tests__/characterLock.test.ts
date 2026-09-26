/**
 * Character row lock tests (fake Prisma, no database).
 */

import { withCharacterRowLock } from '../characterLock';

function makePrisma() {
  const order: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async () => {
      order.push('lock');
      return [{ '?column?': 1 }];
    }),
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      order.push('begin');
      const result = await fn(tx);
      order.push('commit');
      return result;
    }),
  };
  return { prisma, tx, order };
}

test('takes SELECT … FOR UPDATE on the Character row inside the transaction before running fn', async () => {
  const { prisma, tx, order } = makePrisma();

  const result = await withCharacterRowLock(prisma as any, 'char-1', async (client) => {
    order.push('fn');
    expect(client).toBe(tx);
    return 42;
  });

  expect(result).toBe(42);
  expect(order).toEqual(['begin', 'lock', 'fn', 'commit']);
  expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  const [strings, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
  expect(strings.join('$').replace(/\s+/g, ' ').trim()).toBe(
    'SELECT 1 FROM "Character" WHERE "id" = $ FOR UPDATE'
  );
  expect(values).toEqual(['char-1']);
});

test('propagates errors from fn (the transaction rolls back)', async () => {
  const { prisma } = makePrisma();
  await expect(
    withCharacterRowLock(prisma as any, 'char-1', async () => {
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');
});
