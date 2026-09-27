/** Match spell names across case, accents, spaces, dashes and apostrophes. */
export function normalizeSpellName(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[\s'’`\-‐‑–—]/g, '');
}
