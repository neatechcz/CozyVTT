// ============================================
// Human-readable (Czech) labels for D&D 5e character data paths
// Used by the sheet reset panel; unknown paths fall back to the raw path.
// ============================================

const DND5E_FIELD_LABELS: Record<string, string> = {
  characterName: 'Jméno postavy',
  class: 'Povolání',
  level: 'Úroveň',
  race: 'Rasa',
  background: 'Zázemí',
  alignment: 'Přesvědčení',
  experiencePoints: 'Zkušenosti',
  inspiration: 'Inspirace',
  proficiencyBonus: 'Zdatnostní bonus',
  armorClass: 'Obranné číslo',
  initiative: 'Iniciativa',
  speed: 'Rychlost',
  'hp.current': 'Aktuální HP',
  'hp.maximum': 'Maximální HP',
  'hp.temporary': 'Dočasné HP',
  'deathSaves.successes': 'Záchrany před smrtí – úspěchy',
  'deathSaves.failures': 'Záchrany před smrtí – neúspěchy',
  hitDice: 'Kostky životů',
  conditions: 'Stavy',
  'currency.cp': 'Měďáky',
  'currency.sp': 'Stříbrňáky',
  'currency.ep': 'Elektrum',
  'currency.gp': 'Zlaťáky',
  'currency.pp': 'Platiňáky',
  inventory: 'Inventář',
  attacks: 'Útoky',
  'spellcasting.spells': 'Kouzla',
  'spellcasting.cantrips': 'Triky',
  featuresAndTraits: 'Schopnosti a rysy',
  backstory: 'Příběh',
  treasure: 'Poklad',
};

const SPELL_SLOT_EXPENDED = /^spellcasting\.slots\.(\d+)\.expended$/;
const SPELL_SLOT_TOTAL = /^spellcasting\.slots\.(\d+)\.total$/;

export function getDnd5eFieldLabel(path: string): string {
  // `""` is the whole document (data that is not path-addressable)
  if (path === '') return 'Celý list postavy';

  const known = DND5E_FIELD_LABELS[path];
  if (known) return known;

  const expended = SPELL_SLOT_EXPENDED.exec(path);
  if (expended) return `Použité sloty ${expended[1]}. úrovně`;

  const total = SPELL_SLOT_TOTAL.exec(path);
  if (total) return `Sloty ${total[1]}. úrovně`;

  return path;
}
