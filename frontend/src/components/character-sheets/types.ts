/**
 * Shared types for character sheet components
 */

import { Character } from '../../types';

/**
 * Character sheet display mode
 * - 'view': Read-only display of character data
 * - 'edit': Editable form for modifying character data
 */
export type CharacterSheetMode = 'view' | 'edit';

/**
 * Shared props interface for all character sheet components
 * All game-specific character sheets must implement this interface
 */
export interface CharacterSheetProps {
  /** The character to display */
  character: Character;

  /** Display mode (view or edit) */
  mode: CharacterSheetMode;

  /** Callback when character data is saved (edit mode only) */
  onSave?: (data: any, showToast?: boolean, tokenImageUrl?: string) => Promise<void>;

  /** Callback when edit mode is cancelled */
  onCancel?: () => void;

  /**
   * Live sync (D&D 5e editor only; other systems ignore these): data from a
   * remote update, applied whenever `externalDataVersion` changes, and a
   * callback reporting every local form change.
   */
  externalData?: object;
  externalBase?: object;
  externalDataVersion?: number;
  onLocalChange?: (
    data: any,
    origin: 'user' | 'system',
    rebaseResets?: import('../../utils/characterMerge').ResetField[],
    appliedVersion?: number,
  ) => void;
  onDiscardLocalChanges?: () => void;
}
