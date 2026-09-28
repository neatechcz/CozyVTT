/**
 * Character Sheet Viewer Modal
 */

import { useState, useEffect } from 'react';
import { X, Shield, User as UserIcon } from 'lucide-react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useAuth } from '@/contexts/AuthContext';
import { useOptionalWebSocket } from '@/contexts/WebSocketContext';
import { canEditCharacter, canRollAsCharacter } from '@/services/permissions';
import { api } from '@/services/api';
import type { Character, GameSystem, CampaignMembership } from '@/types';

// Import view components
import { DnD5eCharacterView } from '../character-sheets/dnd5e/DnD5eCharacterView';
import Pathfinder2eCharacterView from '../character-sheets/pathfinder2e/Pathfinder2eCharacterView';
import Shadowrun6eCharacterSheet from '../character-sheets/shadowrun6e/Shadowrun6eCharacterSheet';
import CallOfCthulhu7eCharacterView from '../character-sheets/call-of-cthulhu-7e/CallOfCthulhu7eCharacterView';
import { FlexibleCharacterSheetView } from '../character-sheets/flexible/FlexibleCharacterSheetView';

// Import editor modal
import CharacterSheetEditorModal from './CharacterSheetEditorModal';

interface CharacterSheetViewerModalProps {
  character: Character;
  /**
   * Campaign context, when the sheet was opened from inside a campaign. Absent
   * when opened from the character gallery, where there is no campaign — and a
   * character there is always your own, so ownership alone decides editing.
   */
  campaignId?: string;
  membership?: CampaignMembership;
  onClose: () => void;
}

export default function CharacterSheetViewerModal({
  character: initialCharacter,
  campaignId: _campaignId,
  membership,
  onClose,
}: CharacterSheetViewerModalProps) {
  const { user } = useAuth();
  // Optional: this modal opens both from the campaign roster, where there is a
  // websocket, and from the character gallery, where there is not. Live updates
  // and click-to-roll are a bonus in the first case rather than a requirement.
  const ws = useOptionalWebSocket();
  const socket = ws?.socket;
  const [character, setCharacter] = useState(initialCharacter);
  const [ownerName, setOwnerName] = useState<string>('');
  const [showEditor, setShowEditor] = useState(false);

  // Fetch character owner's name
  useEffect(() => {
    const fetchOwnerName = async () => {
      try {
        const response = await api.getUser(character.userId);
        setOwnerName(response.user.displayName);
      } catch (error) {
        console.error('Error fetching character owner:', error);
        setOwnerName('Unknown Player');
      }
    };

    if (character.userId !== user?.id) {
      fetchOwnerName();
    } else {
      setOwnerName('You');
    }
  }, [character.userId, user?.id]);

  // Listen for character updates via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleCharacterUpdate = (data: { characterId: string; character?: Character }) => {
      // The same event is also sent to campaigns that merely hold a token for
      // this character, and those carry no sheet — reading it is not something
      // membership of *that* campaign entitles you to. Nothing to refresh here.
      if (!data.character) return;
      if (data.characterId === character.id) {
        console.log('Character updated - refreshing viewer');
        setCharacter(data.character);
      }
    };

    socket.on('character.updated', handleCharacterUpdate);

    return () => {
      socket.off('character.updated', handleCharacterUpdate);
    };
  }, [socket, character.id]);

  // Check if user can edit
  const canEdit = user ? canEditCharacter(user, character, membership) : false;
  // Reading someone else's sheet is deliberate — the server lets any campaign
  // member do it. Rolling from it is not: those are their modifiers.
  const canRoll = user ? canRollAsCharacter(user, character, membership) : false;
  const isDMEditingOtherCharacter =
    membership?.role === 'DM' && character.userId !== user?.id;

  // Handle edit - open editor modal
  const handleEdit = () => {
    setShowEditor(true);
  };

  // Handle editor save - refresh character data
  const handleEditorSaved = async () => {
    try {
      const { character: updatedCharacter } = await api.getCharacter(character.id);
      setCharacter(updatedCharacter);
    } catch (error) {
      console.error('Error refreshing character after save:', error);
    }
  };

  // Close editor modal
  const handleCloseEditor = () => {
    setShowEditor(false);
  };

  const modalRef = useFocusTrap(true, onClose);

  // Get game system display name
  const getSystemName = (gameSystem: GameSystem | null) => {
    switch (gameSystem) {
      case 'DND_5E':
        return 'D&D 5th Edition';
      case 'PATHFINDER_2E':
        return 'Pathfinder 2nd Edition';
      case 'SHADOWRUN_6E':
        return 'Shadowrun 6th Edition';
      case 'CALL_OF_CTHULHU_7E':
        return 'Call of Cthulhu 7th Edition';
      case null:
        return 'Flexible/Custom';
      default:
        return gameSystem;
    }
  };

  // Handle click-to-roll — emit dice roll via WebSocket
  const handleRoll = (expression: string, purpose: string) => {
    if (socket) {
      // Named so the panel heads the entry with the character whose sheet this
      // is, not with whoever happens to be reading it.
      socket.emitDiceRoll({ expression, purpose, characterName: character.name });
    }
  };

  // Passed to the sheet views only when this viewer may roll; without it the
  // stats render as plain text rather than clickable rolls.
  const rollHandler = canRoll ? handleRoll : undefined;

  // Spending follows the same rule as rolling. The server checks it again —
  // owner or DM — so this only decides whether the control is offered.
  const spendHitDie = canRoll
    ? (index: number) => socket?.emitHitDiceSpend({ characterId: character.id, index })
    : undefined;

  // Render appropriate character sheet view based on game system
  const renderCharacterSheet = () => {
    switch (character.gameSystem) {
      case 'DND_5E':
        return <DnD5eCharacterView character={character} onEdit={canEdit ? handleEdit : undefined} onRoll={rollHandler} onSpendHitDie={spendHitDie} />;
      case 'PATHFINDER_2E':
        return <Pathfinder2eCharacterView character={character} onEdit={canEdit ? handleEdit : undefined} onRoll={rollHandler} />;
      case 'SHADOWRUN_6E':
        return <Shadowrun6eCharacterSheet character={character} mode="view" />;
      case 'CALL_OF_CTHULHU_7E':
        return <CallOfCthulhu7eCharacterView character={character} onEdit={canEdit ? handleEdit : undefined} onRoll={rollHandler} />;
      default:
        return <FlexibleCharacterSheetView character={character} onEdit={canEdit ? handleEdit : undefined} />;
    }
  };

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4 bg-black/70 backdrop-blur-sm" aria-hidden="true">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="character-sheet-viewer-title"
        className="bg-soft-cream border-2 border-moss-green/30 rounded-none sm:rounded-xl shadow-2xl w-full max-w-6xl h-[100dvh] sm:h-auto sm:max-h-[95dvh] min-w-0 overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex min-w-0 items-start justify-between gap-2 p-3 sm:p-6 border-b border-moss-green/20 bg-parchment/30">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-full bg-moss-green/10">
                <UserIcon className="w-5 h-5 text-brand-ink" />
              </div>
              <div className="min-w-0">
                <h2 id="character-sheet-viewer-title" className="break-words text-lg sm:text-2xl font-bold text-moss-green">
                  {character.name}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-warm-gray">
                  <span>Player: {ownerName}</span>
                  <span>•</span>
                  <span>{getSystemName(character.gameSystem)}</span>
                </div>
              </div>
            </div>

            {/* DM Edit Banner */}
            {isDMEditingOtherCharacter && (
              <div className="mt-3 flex items-center gap-2 px-3 py-2 bg-moss-green/10 border border-moss-green/30 rounded-lg">
                <Shield className="w-4 h-4 text-brand-ink" />
                <p className="text-sm text-brand-ink">
                  You are viewing <strong>{ownerName}'s</strong> character as DM
                </p>
              </div>
            )}
          </div>

          {/* Actions; Edit is available on the sheet itself. */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-2 sm:ml-4">
            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="p-2 rounded-lg hover:bg-stone-gray/10 transition-colors"
            >
              <X className="w-5 h-5 text-stone-gray" />
            </button>
          </div>
        </div>

        {/* Character Sheet Content */}
        <div className="min-w-0 flex-1 overflow-y-auto p-2 sm:p-6">
          {renderCharacterSheet()}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-4 border-t border-moss-green/20 bg-parchment/30">
          <button
            onClick={onClose}
            className="px-6 py-2 rounded-lg bg-stone-gray/10 text-stone-gray hover:bg-stone-gray/20 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>

      {/* Character Editor Modal */}
      {showEditor && (
        <CharacterSheetEditorModal
          character={character}
          onClose={handleCloseEditor}
          onSaved={handleEditorSaved}
        />
      )}
    </>
  );
}
