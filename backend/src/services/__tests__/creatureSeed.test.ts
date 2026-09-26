/**
 * creatureSeed — Unit Tests
 *
 * No database and no network: the Open5e response is a fixture object and
 * Prisma is an in-memory fake exposing only the creatureTemplate calls the
 * seeder uses.
 */

import { PrismaClient } from '@prisma/client';
import { mapOpen5eMonster, seedSrdCreatures, Open5eMonster } from '../creatureSeed';

function monster(overrides: Partial<Open5eMonster> = {}): Open5eMonster {
  return {
    slug: 'goblin',
    name: 'Goblin',
    size: 'Small',
    type: 'humanoid',
    subtype: 'goblinoid',
    group: null,
    alignment: 'neutral evil',
    armor_class: 15,
    armor_desc: 'leather armor, shield',
    hit_points: 7,
    hit_dice: '2d6',
    speed: { walk: 30 },
    strength: 8,
    dexterity: 14,
    constitution: 10,
    intelligence: 10,
    wisdom: 8,
    charisma: 8,
    strength_save: null,
    dexterity_save: null,
    constitution_save: null,
    intelligence_save: null,
    wisdom_save: null,
    charisma_save: null,
    skills: { stealth: 6 },
    senses: 'darkvision 60 ft., passive Perception 9',
    languages: 'Common, Goblin',
    challenge_rating: '1/4',
    cr: 0.25,
    actions: [{ name: 'Scimitar', desc: 'Melee Weapon Attack: +4 to hit.' }],
    bonus_actions: null,
    reactions: null,
    special_abilities: [{ name: 'Nimble Escape', desc: 'Disengage or Hide as a bonus action.' }],
    legendary_desc: '',
    legendary_actions: null,
    damage_vulnerabilities: '',
    damage_resistances: '',
    damage_immunities: '',
    condition_immunities: '',
    document__slug: 'wotc-srd',
    document__title: 'Systems Reference Document',
    ...overrides,
  };
}

const GOBLIN = monster();
const ORC = monster({ slug: 'orc', name: 'Orc', size: 'Medium', subtype: 'orc', hit_points: 15, hit_dice: '2d8+6' });

interface FakeTemplate {
  id: string;
  name: string;
  gameSystem: string | null;
  source: string;
  statBlock: unknown;
  [key: string]: unknown;
}

function fakePrisma(initial: FakeTemplate[]) {
  const rows: FakeTemplate[] = initial.map((r) => JSON.parse(JSON.stringify(r)));
  const creatureTemplate = {
    findMany: jest.fn(async ({ where }: { where?: { source?: string } } = {}) =>
      rows.filter((r) => !where?.source || r.source === where.source).map((r) => JSON.parse(JSON.stringify(r))),
    ),
    create: jest.fn(async ({ data }: { data: FakeTemplate }) => {
      rows.push(JSON.parse(JSON.stringify(data)));
      return data;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeTemplate> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error(`no row ${where.id}`);
      Object.assign(row, JSON.parse(JSON.stringify(data)));
      return row;
    }),
  };
  return { prisma: { creatureTemplate } as unknown as PrismaClient, rows, creatureTemplate };
}

function existingSrd(id: string, m: Open5eMonster, statBlockExtra: Record<string, unknown> = {}): FakeTemplate {
  const { hp: _hp, ...withoutHp } = mapOpen5eMonster(m).statBlock as Record<string, unknown>;
  return { id, name: m.name, gameSystem: 'DND_5E', source: 'srd', statBlock: { ...withoutHp, ...statBlockExtra } };
}

describe('mapOpen5eMonster', () => {
  it('stores hit points as { average, formula } in the stat block', () => {
    const mapped = mapOpen5eMonster(GOBLIN);
    expect(mapped.statBlock.hp).toEqual({ average: 7, formula: '2d6' });
  });

  it('keeps the existing stat block fields', () => {
    const mapped = mapOpen5eMonster(GOBLIN);
    expect(mapped).toMatchObject({ name: 'Goblin', gameSystem: 'DND_5E', source: 'srd', challengeRating: '1/4' });
    expect(mapped.statBlock).toMatchObject({ ac: 15, speed: '30 ft.', creatureType: 'Small humanoid (goblinoid)', xp: 50 });
  });

  it('omits the formula when Open5e gives no hit dice', () => {
    const mapped = mapOpen5eMonster(monster({ hit_dice: '' }));
    expect(mapped.statBlock.hp).toEqual({ average: 7 });
  });
});

describe('seedSrdCreatures', () => {
  it('creates missing SRD creatures with hp and reports updatedHp = 0 on an empty library', async () => {
    const { prisma, rows } = fakePrisma([]);
    const result = await seedSrdCreatures(prisma, async () => [GOBLIN, ORC]);

    expect(result).toEqual({ fetched: 2, created: 2, skipped: 0, alreadyExisted: 0, updatedHp: 0 });
    expect(rows.map((r) => (r.statBlock as { hp: unknown }).hp)).toEqual([
      { average: 7, formula: '2d6' },
      { average: 15, formula: '2d8+6' },
    ]);
  });

  it('backfills hp on existing SRD templates without creating duplicates', async () => {
    const { prisma, rows, creatureTemplate } = fakePrisma([existingSrd('g1', GOBLIN), existingSrd('o1', ORC)]);
    const result = await seedSrdCreatures(prisma, async () => [GOBLIN, ORC]);

    expect(result).toEqual({ fetched: 2, created: 0, skipped: 2, alreadyExisted: 2, updatedHp: 2 });
    expect(creatureTemplate.create).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    const goblin = rows.find((r) => r.id === 'g1')!.statBlock as Record<string, unknown>;
    expect(goblin.hp).toEqual({ average: 7, formula: '2d6' });
    // the rest of the stat block is preserved
    expect(goblin).toMatchObject({ ac: 15, speed: '30 ft.', challengeRating: '1/4' });
  });

  it('does not overwrite hp that is already present', async () => {
    const custom = { average: 12, formula: '3d6+2' };
    const { prisma, rows, creatureTemplate } = fakePrisma([existingSrd('g1', GOBLIN, { hp: custom })]);
    const result = await seedSrdCreatures(prisma, async () => [GOBLIN]);

    expect(result.updatedHp).toBe(0);
    expect(creatureTemplate.update).not.toHaveBeenCalled();
    expect((rows[0].statBlock as { hp: unknown }).hp).toEqual(custom);
  });

  it('never touches custom templates with the same name', async () => {
    const customGoblin: FakeTemplate = { ...existingSrd('c1', GOBLIN), source: 'custom' };
    const { prisma, rows, creatureTemplate } = fakePrisma([customGoblin, existingSrd('g1', GOBLIN)]);
    const result = await seedSrdCreatures(prisma, async () => [GOBLIN]);

    expect(result.updatedHp).toBe(1);
    expect(creatureTemplate.update).toHaveBeenCalledTimes(1);
    expect(creatureTemplate.update.mock.calls[0][0].where).toEqual({ id: 'g1' });
    expect((rows.find((r) => r.id === 'c1')!.statBlock as { hp?: unknown }).hp).toBeUndefined();
  });

  it('only backfills SRD templates of the same game system', async () => {
    const otherSystem: FakeTemplate = { ...existingSrd('x1', GOBLIN), gameSystem: 'PATHFINDER_2E' };
    const { prisma, creatureTemplate } = fakePrisma([otherSystem, existingSrd('g1', GOBLIN)]);
    const result = await seedSrdCreatures(prisma, async () => [GOBLIN]);

    expect(result.updatedHp).toBe(1);
    expect(creatureTemplate.update.mock.calls.map((c) => c[0].where.id)).toEqual(['g1']);
  });

  it('creates only the missing creatures and backfills the rest in one run', async () => {
    const { prisma, rows } = fakePrisma([existingSrd('g1', GOBLIN)]);
    const result = await seedSrdCreatures(prisma, async () => [GOBLIN, ORC]);

    expect(result).toEqual({ fetched: 2, created: 1, skipped: 1, alreadyExisted: 1, updatedHp: 1 });
    expect(rows.filter((r) => r.name === 'Goblin')).toHaveLength(1);
    expect(rows.filter((r) => r.name === 'Orc')).toHaveLength(1);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const { prisma, creatureTemplate } = fakePrisma([existingSrd('g1', GOBLIN)]);
    await seedSrdCreatures(prisma, async () => [GOBLIN]);
    creatureTemplate.update.mockClear();
    const second = await seedSrdCreatures(prisma, async () => [GOBLIN]);

    expect(second).toEqual({ fetched: 1, created: 0, skipped: 1, alreadyExisted: 1, updatedHp: 0 });
    expect(creatureTemplate.update).not.toHaveBeenCalled();
  });
});
