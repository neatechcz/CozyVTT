import { planStatBlockBackfill } from '../creatureProficiencyBackfill';

/** An SRD Goblin exactly as the importer stores it: totals, no structure. */
const goblin = {
  ac: 15,
  hpMax: 7,
  speed: '30 ft.',
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
  skills: { stealth: 6 },
  challengeRating: '1/4',
};

describe('planStatBlockBackfill', () => {
  describe('the guarantee that no printed number changes', () => {
    it("keeps the Goblin's Stealth at +6 while recording it as expertise", () => {
      const plan = planStatBlockBackfill(goblin)!;

      expect(plan.statBlock.skills).toEqual({ stealth: 6 });
      expect(plan.statBlock.proficiencies?.skills?.stealth).toBe('expertise');
    });

    it('leaves every other field untouched', () => {
      const plan = planStatBlockBackfill(goblin)!;

      expect(plan.statBlock.ac).toBe(goblin.ac);
      expect(plan.statBlock.hpMax).toBe(goblin.hpMax);
      expect(plan.statBlock.abilities).toEqual(goblin.abilities);
      expect(plan.statBlock.challengeRating).toBe('1/4');
    });

    it('keeps a value it cannot reconcile, marking it custom rather than fixing it', () => {
      const odd = { ...goblin, skills: { perception: 17 } };
      const plan = planStatBlockBackfill(odd)!;

      expect(plan.statBlock.skills).toEqual({ perception: 17 });
      expect(plan.statBlock.proficiencies?.skills?.perception).toBe('custom');
      expect(plan.customCount).toBe(1);
    });
  });

  describe('inference', () => {
    it('recognises a proficient save', () => {
      // Wis 8 (-1) with CR 1/4 proficiency (+2) gives +1.
      const plan = planStatBlockBackfill({ ...goblin, savingThrows: { wis: 1 } })!;
      expect(plan.statBlock.proficiencies?.saves?.wis).toBe('proficient');
    });

    it('recognises a save that is only the ability modifier', () => {
      const plan = planStatBlockBackfill({ ...goblin, savingThrows: { dex: 2 } })!;
      expect(plan.statBlock.proficiencies?.saves?.dex).toBe('none');
    });

    it('scales the proficiency bonus with challenge rating', () => {
      // Wis 8 (-1) at CR 17 (+6) gives +5 when proficient.
      const highCr = {
        ...goblin,
        challengeRating: '17',
        savingThrows: { wis: 5 },
      };
      const plan = planStatBlockBackfill(highCr)!;
      expect(plan.statBlock.proficiencies?.saves?.wis).toBe('proficient');
    });
  });

  describe('Open5e key normalisation', () => {
    // These keys never matched the skill lookup, so those skills lost their
    // ability association in the roll picker.
    it('renames snake_case keys and reports the rename', () => {
      const plan = planStatBlockBackfill({ ...goblin, skills: { animal_handling: 1 } })!;

      expect(plan.statBlock.skills).toEqual({ animalHandling: 1 });
      expect(plan.change.renamedSkills).toEqual([
        { from: 'animal_handling', to: 'animalHandling' },
      ]);
    });

    it('preserves the value across the rename', () => {
      const plan = planStatBlockBackfill({ ...goblin, skills: { sleight_of_hand: 4 } })!;
      expect(plan.statBlock.skills?.sleightOfHand).toBe(4);
    });

    it('does not rename a key that is already canonical', () => {
      const plan = planStatBlockBackfill(goblin)!;
      expect(plan.change.renamedSkills).toEqual([]);
    });

    it('keeps an unrecognised skill as custom rather than discarding it', () => {
      const plan = planStatBlockBackfill({ ...goblin, skills: { basketWeaving: 3 } })!;

      expect(plan.statBlock.skills?.basketWeaving).toBe(3);
      expect(plan.statBlock.proficiencies?.skills?.basketWeaving).toBe('custom');
    });
  });

  describe('when there is nothing to do', () => {
    it('returns null for a creature with no saves or skills', () => {
      const plain = { ...goblin, skills: undefined };
      expect(planStatBlockBackfill(plain)).toBeNull();
    });
  });

  describe('idempotence', () => {
    it('produces the same result when run against its own output', () => {
      const first = planStatBlockBackfill(goblin)!;
      const second = planStatBlockBackfill(first.statBlock)!;

      expect(second.statBlock.skills).toEqual(first.statBlock.skills);
      expect(second.statBlock.proficiencies).toEqual(first.statBlock.proficiencies);
    });
  });
});
