/**
 * D&D 5e editor form shape.
 *
 * `buildDnd5eFormData` normalizes stored character data into the form the
 * editor renders (ensures nested objects exist). The live form store runs it
 * after every server state it adopts. `prepareDnd5eFormForSave` turns the
 * form's free-text list fields into the arrays that are stored.
 */

/**
 * Normalize stored character data into the editor's form shape
 * (ensures nested objects exist). Used on mount and for live updates.
 */
export const buildDnd5eFormData = (data: any): any => ({
  ...data,
  // Ensure nested objects exist
  stats: data.stats || {},
  savingThrows: data.savingThrows || {},
  skills: data.skills || {},
  hp: data.hp || { maximum: 0, current: 0, temporary: 0 },
  deathSaves: data.deathSaves || { successes: 0, failures: 0 },
  spellcasting: data.spellcasting || {
    ability: '',
    spellSaveDC: 0,
    spellAttackBonus: 0,
    cantrips: [],
    slots: {},
    spells: [],
  },
  currency: data.currency || { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
  inventory: data.inventory || [],
  attacks: data.attacks || [],
  hitDice: data.hitDice || [],
  conditions: data.conditions || [],
  proficienciesAndLanguages: data.proficienciesAndLanguages || [],
  // Always use a structured object for proficiencies so the textarea fields work correctly.
  // If legacy data stored proficiencies as an array, ignore it and start with empty strings.
  proficiencies: (data.proficiencies && !Array.isArray(data.proficiencies))
    ? { armor: '', weapons: '', tools: '', languages: '', ...data.proficiencies }
    : { armor: '', weapons: '', tools: '', languages: '' },
  featuresAndTraits: data.featuresAndTraits || [],
  appearance: data.appearance || {},
  personality: data.personality || {},
  alliesAndOrganizations: data.alliesAndOrganizations || { name: '', description: '' },
});

/** Parse comma-separated string into array */
export const parseCommaSeparated = (value: string | string[] | undefined): string[] => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  return value.split(',').map(i => i.trim()).filter(i => i);
};

/**
 * The form as it is stored: comma-separated text fields become arrays, the
 * flat proficiency list is rebuilt, and a theme colour is recorded if the
 * form has none. Returns a new object; the input is never mutated.
 */
export const prepareDnd5eFormForSave = (form: any, defaultThemeColor: string): any => {
  const updatedData = { ...form };

  if (updatedData.themeColor === undefined) {
    updatedData.themeColor = defaultThemeColor;
  }

  // Proficiencies
  if (updatedData.proficiencies && typeof updatedData.proficiencies === 'object') {
    const armorArray = parseCommaSeparated(updatedData.proficiencies.armor);
    const weaponsArray = parseCommaSeparated(updatedData.proficiencies.weapons);
    const toolsArray = parseCommaSeparated(updatedData.proficiencies.tools);
    const languagesArray = parseCommaSeparated(updatedData.proficiencies.languages);

    // Flatten to backwards-compatible array
    updatedData.proficienciesAndLanguages = [
      ...armorArray,
      ...weaponsArray,
      ...toolsArray,
      ...languagesArray,
    ];
  }

  // Features & Traits
  updatedData.featuresAndTraits = parseCommaSeparated(updatedData.featuresAndTraits);

  // Cantrips
  if (updatedData.spellcasting) {
    updatedData.spellcasting = {
      ...updatedData.spellcasting,
      cantrips: parseCommaSeparated(updatedData.spellcasting.cantrips),
    };
  }

  return updatedData;
};
