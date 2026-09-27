/**
 * buildStatBlock.ts
 * Assembles an NpcStatBlock from creature-editor form state.
 *
 * This exists as a pure module rather than inline form logic because of the bug
 * it was extracted to fix: the creature editor rebuilt the stat block from form
 * state alone, so every field the form does not render — saving throws, skills,
 * XP, notes — was silently deleted on save. Editing a duplicated SRD creature
 * wiped its Stealth bonus and quietly removed it from the NPC roll picker.
 *
 * The rule this module enforces: fields the form owns are always overwritten
 * (including being cleared), and everything else is carried through untouched.
 */

import type { NpcStatBlock } from '@/types';

export type NameDescription = { name: string; description: string };

/**
 * The subset of a stat block the creature editor form actually renders.
 * Anything absent from this interface is, by definition, carried over from the
 * source stat block rather than rebuilt — which is what makes adding a field to
 * NpcStatBlock safe without revisiting this file.
 */
export interface CreatureFormFields {
  ac: number;
  hpMax: number;
  speed: string;
  abilities: NpcStatBlock['abilities'];
  creatureType: string;
  alignment: string;
  challengeRating: string;
  traits: NameDescription[];
  actions: NameDescription[];
  bonusActions: NameDescription[];
  reactions: NameDescription[];
  legendaryActions: NameDescription[];
  damageVulnerabilities: string;
  damageResistances: string;
  damageImmunities: string;
  conditionImmunities: string;
  senses: string;
  languages: string;
}

/** Drop entries where both the name and description are blank. */
function filterPairs(entries: NameDescription[]): NameDescription[] {
  return entries.filter((p) => p.name.trim() || p.description.trim());
}

/** Collapse an empty list to undefined so the key is omitted on serialisation. */
function orUndefined<T>(list: T[]): T[] | undefined {
  return list.length > 0 ? list : undefined;
}

/**
 * Merge editor form state over a source stat block.
 *
 * @param source The stat block being edited, or undefined when creating a new
 *               creature. Fields the form does not manage are taken from here.
 *               Accepts a partial so a caller can merge in edits made through a
 *               sub-editor (saves and skills) before assembling the whole block;
 *               every required field comes from `form`, so the result is always
 *               complete regardless of how sparse the source is.
 * @param form   The form-managed values.
 *
 * Keys set to `undefined` are omitted by JSON serialisation, so clearing an
 * input genuinely removes the field instead of leaving a stale value behind.
 */
export function buildCreatureStatBlock(
  source: Partial<NpcStatBlock> | undefined,
  form: CreatureFormFields
): NpcStatBlock {
  return {
    // Carry forward everything this form does not edit — savingThrows, skills,
    // proficiencies, xp, hitDice, gameSystem and notes live only here.
    ...source,

    // Fields owned by the form, always overwritten.
    ac: form.ac,
    hpMax: form.hpMax,
    speed: form.speed,
    abilities: { ...form.abilities },
    creatureType: form.creatureType || undefined,
    alignment: form.alignment || undefined,
    challengeRating: form.challengeRating || undefined,
    traits: orUndefined(filterPairs(form.traits)),
    actions: orUndefined(filterPairs(form.actions)),
    bonusActions: orUndefined(filterPairs(form.bonusActions)),
    reactions: orUndefined(filterPairs(form.reactions)),
    legendaryActions: orUndefined(filterPairs(form.legendaryActions)),
    damageVulnerabilities: form.damageVulnerabilities || undefined,
    damageResistances: form.damageResistances || undefined,
    damageImmunities: form.damageImmunities || undefined,
    conditionImmunities: form.conditionImmunities || undefined,
    senses: form.senses || undefined,
    languages: form.languages || undefined,
  };
}
