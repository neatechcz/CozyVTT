/**
 * NpcStatBlock hp — token template validation.
 * `statBlock.hp` is `{ average: number; formula?: string }`.
 */

import { CreateTokenTemplateSchema } from '../tokenTemplates';
import { MapDataSchema, TokenTemplateImportSchema, CreatureTemplateSchema } from '../campaignImport';

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
    expect(result.success && result.data).toMatchObject({ statBlock: { hp: { average: 7, formula: '2d6' } } });
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

describe('movement-only token round trips', () => {
  it('preserves a speed-only map token and token template on import', () => {
    const statBlock = { speed: '30 ft.' };
    expect(CreateTokenTemplateSchema.parse({ name: 'Runner', statBlock }).statBlock).toEqual(statBlock);
    expect(TokenTemplateImportSchema.parse({ name: 'Runner', type: 'npc', statBlock }).statBlock).toEqual(statBlock);
    const map = MapDataSchema.parse({ name: 'Map', imageAssetRef: 'map.png', width: 10, height: 10,
      gridSize: 50, feetPerSquare: 5,
      tokens: [{ name: 'Runner', position: { x: 1, y: 1 }, size: { width: 1, height: 1 }, statBlock }],
    });
    expect(map.tokens[0].statBlock).toEqual(statBlock);
    expect(CreatureTemplateSchema.safeParse({ name: 'Creature', statBlock }).success).toBe(false);
  });
});
