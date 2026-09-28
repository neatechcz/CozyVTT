/**
 * The order investigator characteristics are shown in.
 *
 * This is the order the printed Call of Cthulhu sheet uses, and the single
 * source for both the view and the editor. They used to disagree: the view
 * hardcoded this sequence while the editor iterated `Object.keys()` on the
 * stored data, so the boxes came out in whatever order the JSON happened to
 * hold them — the same character reading differently depending on whether you
 * were looking at it or changing it.
 */
export const COC_CHARACTERISTIC_ORDER = [
  'STR',
  'CON',
  'SIZ',
  'DEX',
  'APP',
  'INT',
  'POW',
  'EDU',
] as const;

export type CoCCharacteristic = (typeof COC_CHARACTERISTIC_ORDER)[number];

/**
 * Characteristic keys present on a sheet, in the canonical order.
 *
 * Anything unrecognised is kept and appended rather than dropped, so a sheet
 * carrying an extra key still shows all of it.
 */
export function orderedCharacteristics(
  characteristics: Record<string, unknown> | null | undefined
): string[] {
  if (!characteristics) return [];
  const known = COC_CHARACTERISTIC_ORDER.filter((key) => key in characteristics);
  const extra = Object.keys(characteristics).filter(
    (key) => !(COC_CHARACTERISTIC_ORDER as readonly string[]).includes(key)
  );
  return [...known, ...extra];
}
