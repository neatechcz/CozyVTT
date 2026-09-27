import type { NpcStatBlock, TokenStatBlock } from '@/types';
export type { TokenStatBlock } from '@/types';

export function isFullNpcStatBlock(block: TokenStatBlock | null | undefined): block is NpcStatBlock {
  return !!block && 'abilities' in block && 'ac' in block &&
    typeof block.ac === 'number' && Number.isFinite(block.ac) &&
    !!block.abilities && ['str', 'dex', 'con', 'int', 'wis', 'cha'].every((key) => {
      const score = block.abilities[key as keyof NpcStatBlock['abilities']];
      return typeof score === 'number' && Number.isFinite(score);
    });
}
