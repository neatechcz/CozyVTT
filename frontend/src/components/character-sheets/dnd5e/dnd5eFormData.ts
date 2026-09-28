import { collectSheetFeatures } from '@/utils/featureEntries';
import { trackedExhaustionLevel } from '@/utils/dnd5eSurvival';
/**
 * D&D 5e editor form shape.
 *
 * `buildDnd5eFormData` normalizes stored character data into the form the
 * editor renders (ensures nested objects exist). The live form store runs it
 * after every server state it adopts. `prepareDnd5eFormForSave` turns the
 * form's free-text list fields into the arrays that are stored.
 */

/**
 * Sort a flat proficiency list into the sheet's categories. Older sheets may
 * contain English or Czech entries; keep unknown entries editable as other.
 */
export const categorizeProficiencies = (all: string[]) => {
  const englishLanguages = new Set([
    'common', 'elvish', 'dwarvish', 'draconic', 'giant', 'gnomish', 'goblin',
    'halfling', 'orc', 'abyssal', 'celestial', 'deep speech', 'infernal',
    'primordial', 'sylvan', 'undercommon', 'aquan', 'auran', 'ignan', 'terran',
    "thieves' cant",
  ]);
  const categories = { armor: [] as string[], weapons: [] as string[], tools: [] as string[], languages: [] as string[], other: [] as string[] };

  for (const proficiency of all) {
    const name = proficiency.toLocaleLowerCase();
    if (englishLanguages.has(name) || /(?:ština|řeč|hantýrka)$/.test(name)) {
      categories.languages.push(proficiency);
    } else if (/armor|shield|zbroj|štít/.test(name)) {
      categories.armor.push(proficiency);
    } else if (/tools?|supplies|kit|instruments?|vehicles?|nářad|náčin|sada|sady/.test(name)) {
      categories.tools.push(proficiency);
    } else if (/weapon|zbran|dagger|sword|bow|axe|mace|staff|crossbow|spear|hammer|dýk|meč|rapír|kuš|luk|šipk|prak|hole|hůl/.test(name)) {
      categories.weapons.push(proficiency);
    } else {
      categories.other.push(proficiency);
    }
  }

  return categories;
};

/**
 * Normalize stored character data into the editor's form shape
 * (ensures nested objects exist). Used on mount and for live updates.
 * Never invents data the sheet does not have: no default `spellcasting`
 * block for a non-spellcaster, and a legacy flat `proficiencies` array is
 * shown through `proficienciesAndLanguages` — the structured category
 * object exists only when the sheet has one (or the user edits a category).
 */
export const buildDnd5eFormData = (data: any): any => {
  const exhaustionLevel = trackedExhaustionLevel(data);
  const { proficiencies: sourceProficiencies, ...characterData } = data;
  const proficienciesAndLanguages = Array.isArray(data.proficienciesAndLanguages)
    ? data.proficienciesAndLanguages
    : Array.isArray(sourceProficiencies)
      ? sourceProficiencies
      : [];
  const structuredProficiencies = sourceProficiencies
    && typeof sourceProficiencies === 'object'
    && !Array.isArray(sourceProficiencies)
    ? { proficiencies: { armor: '', weapons: '', tools: '', languages: '', ...sourceProficiencies } }
    : {};

  return {
    ...characterData,
    ...(exhaustionLevel === undefined ? {} : {
      exhaustionLevel,
      survival: { ...data.survival, exhaustionLevel },
    }),
    // Ensure nested objects exist
    stats: data.stats || {},
    savingThrows: data.savingThrows || {},
    skills: data.skills || {},
    hp: data.hp || { maximum: 0, current: 0, temporary: 0 },
    deathSaves: data.deathSaves || { successes: 0, failures: 0 },
    ...(data.spellcasting ? { spellcasting: data.spellcasting } : {}),
    currency: data.currency || { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    inventory: data.inventory || [],
    attacks: data.attacks || [],
    hitDice: data.hitDice || [],
    conditions: data.conditions || [],
    proficienciesAndLanguages,
    ...structuredProficiencies,
    featuresAndTraits: collectSheetFeatures(data),
    appearance: data.appearance || {},
    personality: data.personality || {},
    alliesAndOrganizations: data.alliesAndOrganizations || { name: '', description: '' },
  };
};

/** Parse comma-separated string into array */
export const parseCommaSeparated = (value: string | string[] | undefined): string[] => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  return value.split(',').map(i => i.trim()).filter(i => i);
};

/**
 * Inputs of the values `prepareDnd5eFormForSave` derives: the flat
 * proficiency list is saved only when the user edited the proficiencies.
 */
export const saveFormInputsOf = (path: string): string[] => {
  if (path === 'exhaustionLevel') return ['survival.exhaustionLevel'];
  if (path === 'proficienciesAndLanguages') return ['proficiencies'];
  if (path === 'featuresAndTraits' || path === 'spellcasting.cantrips') return [path];
  return [];
};

/**
 * The form as it is stored: comma-separated text fields become arrays, the
 * flat proficiency list is rebuilt, and a theme colour is recorded if the
 * form has none. Returns a new object; the input is never mutated.
 */
export const prepareDnd5eFormForSave = (form: any, defaultThemeColor: string): any => {
  const updatedData = { ...form };

  if (form.survival?.exhaustionLevel !== undefined) {
    updatedData.exhaustionLevel = form.survival.exhaustionLevel;
  }

  if (updatedData.themeColor === undefined) {
    updatedData.themeColor = defaultThemeColor;
  }

  // Proficiencies
  if (updatedData.proficiencies && typeof updatedData.proficiencies === 'object') {
    const armorArray = parseCommaSeparated(updatedData.proficiencies.armor);
    const weaponsArray = parseCommaSeparated(updatedData.proficiencies.weapons);
    const toolsArray = parseCommaSeparated(updatedData.proficiencies.tools);
    const languagesArray = parseCommaSeparated(updatedData.proficiencies.languages);
    // A legacy structured object may have no other field; recover those
    // entries from the flat list until the player edits that field.
    const originalProficiencies: string[] = Array.isArray(updatedData.proficienciesAndLanguages)
      ? updatedData.proficienciesAndLanguages
      : [];
    const otherArray = updatedData.proficiencies.other === undefined
      ? categorizeProficiencies(originalProficiencies).other
      : parseCommaSeparated(updatedData.proficiencies.other);

    // Flatten to backwards-compatible array
    updatedData.proficienciesAndLanguages = [
      ...armorArray,
      ...weaponsArray,
      ...toolsArray,
      ...languagesArray,
      ...otherArray,
    ];
  }

  // Features & Traits
  updatedData.featuresAndTraits = collectSheetFeatures(updatedData);
  delete updatedData.features;

  // Cantrips
  if (updatedData.spellcasting) {
    updatedData.spellcasting = {
      ...updatedData.spellcasting,
      cantrips: parseCommaSeparated(updatedData.spellcasting.cantrips),
    };
  }

  return updatedData;
};
