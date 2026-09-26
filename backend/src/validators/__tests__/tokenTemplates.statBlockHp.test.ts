/**
 * NpcStatBlock hp — token template validation.
 * `statBlock.hp` is `{ average: number; formula?: string }`.
 */

import { CreateTokenTemplateSchema } from '../tokenTemplates';

const baseStatBlock = {
  ac: 15,
  speed: '30 ft.',
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
};

function parse(statBlock: Record<string, unknown>) {
  return CreateTokenTemplateSchema.safeParse({ name: 'Goblin', type: 'npc', statBlock });
}

describe('token template statBlock.hp', () => {
  it('accepts and keeps { average, formula }', () => {
    const result = parse({ ...baseStatBlock, hp: { average: 7, formula: '2d6' } });
    expect(result.success).toBe(true);
    expect(result.success && result.data.statBlock?.hp).toEqual({ average: 7, formula: '2d6' });
  });

  it('accepts hp without a formula', () => {
    expect(parse({ ...baseStatBlock, hp: { average: 7 } }).success).toBe(true);
  });

  it('keeps accepting stat blocks without hp', () => {
    expect(parse(baseStatBlock).success).toBe(true);
  });

  it('rejects a non-numeric average', () => {
    expect(parse({ ...baseStatBlock, hp: { average: 'seven' } }).success).toBe(false);
  });
});
