/**
 * D&D 5e editor form shape.
 *
 * `buildDnd5eFormData` normalizes stored character data into the form the
 * editor renders (ensures nested objects exist). The live form store runs it
 * after every server state it adopts. `prepareDnd5eFormForSave` turns the
 * form's free-text list fields into the arrays that are stored.
 */

/**
 * Sort a flat proficiency list into the editor's categories. Entries that fit
 * no category (e.g. "Saving Throws: Strength") are in none of the lists.
 */
export const categorizeProficiencies = (all: string[]) => {
  const languages = ['Common', 'Elvish', 'Dwarvish', 'Draconic', 'Giant', 'Gnomish', 'Goblin', 'Halfling', 'Orc', 'Abyssal', 'Celestial', 'Deep Speech', 'Infernal', 'Primordial', 'Sylvan', 'Undercommon'];
  const armorKeywords = ['Armor', 'Shield'];
  const toolKeywords = ['Tools', 'Supplies', 'Kit', 'Instruments', 'Vehicles', 'Vehicle'];

  const armor = all.filter((proficiency) => armorKeywords.some((keyword) => proficiency.includes(keyword)));
  const weapons = all.filter((proficiency) =>
    !armorKeywords.some((keyword) => proficiency.includes(keyword))
    && !toolKeywords.some((keyword) => proficiency.includes(keyword))
    && !languages.includes(proficiency)
    && (proficiency.includes('Weapon') || ['Dagger', 'Sword', 'Bow', 'Axe', 'Mace', 'Staff', 'Crossbow', 'Spear', 'Hammer'].some((weapon) => proficiency.includes(weapon))),
  );
  const tools = all.filter((proficiency) => toolKeywords.some((keyword) => proficiency.includes(keyword)));
  const languageProficiencies = all.filter((proficiency) => languages.includes(proficiency));

  return { armor, weapons, tools, languages: languageProficiencies };
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
    featuresAndTraits: data.featuresAndTraits || [],
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

  if (updatedData.themeColor === undefined) {
    updatedData.themeColor = defaultThemeColor;
  }

  // Proficiencies
  if (updatedData.proficiencies && typeof updatedData.proficiencies === 'object') {
    const armorArray = parseCommaSeparated(updatedData.proficiencies.armor);
    const weaponsArray = parseCommaSeparated(updatedData.proficiencies.weapons);
    const toolsArray = parseCommaSeparated(updatedData.proficiencies.tools);
    const languagesArray = parseCommaSeparated(updatedData.proficiencies.languages);
    // Entries that fit no category (e.g. "Saving Throws: Strength") have no
    // field of their own: keep them from the current list
    const originalProficiencies: string[] = Array.isArray(updatedData.proficienciesAndLanguages)
      ? updatedData.proficienciesAndLanguages
      : [];
    const categorizedOriginals = new Set(Object.values(categorizeProficiencies(originalProficiencies)).flat());
    const uncategorizedOriginals = originalProficiencies
      .filter((proficiency) => !categorizedOriginals.has(proficiency));

    // Flatten to backwards-compatible array
    updatedData.proficienciesAndLanguages = [
      ...armorArray,
      ...weaponsArray,
      ...toolsArray,
      ...languagesArray,
      ...uncategorizedOriginals,
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
