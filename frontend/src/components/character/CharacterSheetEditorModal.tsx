/**
 * Character Sheet Editor Modal
 */

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useToast } from '@/contexts/ToastContext';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { useLiveCharacterSync } from '@/hooks/useLiveCharacterSync';
import { api } from '@/services/api';
import { GameSystem, type Character } from '@/types';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import SheetResetPanel from './SheetResetPanel';
import { buildDnd5eFormData } from '../character-sheets/dnd5e/dnd5eFormData';

// Import editor components
import DnD5eCharacterEditor from '../character-sheets/dnd5e/DnD5eCharacterEditor';
import Pathfinder2eCharacterEditor from '../character-sheets/pathfinder2e/Pathfinder2eCharacterEditor';
import CallOfCthulhu7eCharacterEditor from '../character-sheets/call-of-cthulhu-7e/CallOfCthulhu7eCharacterEditor';
import { FlexibleCharacterSheetEdit } from '../character-sheets/flexible/FlexibleCharacterSheetEdit';

interface CharacterSheetEditorModalProps {
  character: Character;
  onClose: () => void;
  onSaved?: () => void; // Optional callback after save
}

export default function CharacterSheetEditorModal({
  character,
  onClose,
  onSaved,
}: CharacterSheetEditorModalProps) {
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const { showToast } = useToast();
  const { socket, reconnectCount } = useWebSocket();

  // Live sync (D&D 5e only): other people's changes flow into the open
  // editor; saving sends only the changed fields.
  const isDnd5e = character.gameSystem === GameSystem.DND_5E;
  const liveSync = useLiveCharacterSync({ character, socket, isDnd5e, normalizeForm: buildDnd5eFormData });
  const { refresh: refreshLiveCharacter } = liveSync;

  // After the campaign room is rejoined (reconnect), reload the character:
  // changes whose broadcast was missed while disconnected are merged like any
  // remote change (touched fields that collide are reported in the panel).
  const seenReconnectCountRef = useRef(reconnectCount);
  useEffect(() => {
    if (reconnectCount === seenReconnectCountRef.current) return;
    seenReconnectCountRef.current = reconnectCount;
    if (!isDnd5e) return;
    refreshLiveCharacter().catch((err) => {
      console.warn('Failed to reload the character after reconnecting:', err);
    });
  }, [reconnectCount, isDnd5e, refreshLiveCharacter]);

  // Handle save. The editors pass a freshly-uploaded token image URL as the
  // third argument — forward it so the character's token actually updates.
  // (Omit it when undefined so an edit that didn't touch the token keeps the
  // existing image.)
  const handleSave = async (data: any, _showToast?: boolean, tokenImageUrl?: string) => {
    try {
      setSaving(true);

      if (isDnd5e) {
        const outcome = await liveSync.save();

        // The token image is not part of `data` — persist it separately
        if (tokenImageUrl !== undefined) {
          await api.updateCharacter(character.id, { tokenImageUrl });
        }

        if (onSaved) {
          onSaved();
        }

        if (outcome.status === 'stale') {
          // Nothing was written: the newer sheet is merged into the form
          // (collisions in the panel) — keep the editor open to save again
          showToast(outcome.message, 'warning');
          return;
        }

        if (outcome.status === 'conflicts') {
          // Keep the editor open so the user can re-enter the reset fields
          showToast('Některé změny kolidovaly — viz panel', 'warning');
          return;
        }

        showToast('Character saved!', 'success');
        onClose();
        return;
      }

      await api.updateCharacter(character.id, {
        data,
        ...(tokenImageUrl !== undefined ? { tokenImageUrl } : {}),
      });

      // Call optional callback
      if (onSaved) {
        onSaved();
      }

      // Close modal
      onClose();
    } catch (error: any) {
      console.error('Error saving character:', error);

      // Show detailed error message
      const errorMessage = error.response?.data?.message || 'Failed to save character. Please try again.';
      const validationErrors = error.response?.data?.validationErrors;

      if (validationErrors) {
        console.error('Validation errors:', validationErrors);
        showToast(`Validation Error: ${errorMessage}`, 'error');
      } else {
        showToast(errorMessage, 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  // Handle cancel
  const handleCancel = () => {
    setConfirmClose(true);
  };

  const modalRef = useFocusTrap(true, onClose);

  // Render appropriate character sheet editor based on game system
  const renderCharacterEditor = () => {
    switch (character.gameSystem) {
      case 'DND_5E':
        return (
          <>
            <div className="px-4 pt-4 pr-16 empty:hidden">
              <SheetResetPanel resets={liveSync.resets} onDismiss={liveSync.dismissResets} />
            </div>
            <DnD5eCharacterEditor
              character={character}
              onSave={handleSave}
              onCancel={handleCancel}
              formStore={liveSync.formStore}
            />
          </>
        );
      case 'PATHFINDER_2E':
        return (
          <Pathfinder2eCharacterEditor
            character={character}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        );
      case 'CALL_OF_CTHULHU_7E':
        return (
          <CallOfCthulhu7eCharacterEditor
            character={character}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        );
      case 'SHADOWRUN_6E':
        // Shadowrun editor not yet implemented
        return (
          <div className="glass-panel p-6">
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <h3 className="text-xl font-semibold text-warm-gray">
                Shadowrun 6e Character Editor
              </h3>
              <p className="text-stone-gray text-center max-w-md">
                The Shadowrun 6th Edition character editor is not yet implemented.
              </p>
              <button
                onClick={onClose}
                className="px-6 py-2 rounded-lg bg-moss-green text-white hover:bg-moss-green/90 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        );
      default:
        // Flexible character sheet
        return (
          <FlexibleCharacterSheetEdit
            character={character}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        );
    }
  };

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" aria-hidden="true">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="character-sheet-editor-title"
        className="bg-soft-cream border-2 border-moss-green/30 rounded-xl shadow-2xl w-full max-w-6xl max-h-[95vh] overflow-hidden flex flex-col"
      >
        {/* Close Button */}
        <div className="absolute top-4 right-4 z-10">
          <button
            onClick={handleCancel}
            aria-label="Close dialog"
            className="p-2 rounded-lg bg-soft-cream/90 hover:bg-stone-gray/10 transition-colors border border-moss-green/20"
            disabled={saving}
          >
            <X className="w-5 h-5 text-stone-gray" />
          </button>
        </div>

        {/* Visually hidden title for accessibility */}
        <h2 id="character-sheet-editor-title" className="sr-only">
          Edit Character Sheet: {character.name}
        </h2>

        {/* Editor Content */}
        <div className="flex-1 overflow-y-auto">
          {renderCharacterEditor()}
        </div>
      </div>
    </div>
    {/* ConfirmDialog must be rendered AFTER the modal overlay so it appears
        on top at the same z-50 stacking level (later DOM = visually on top). */}
    <ConfirmDialog
      isOpen={confirmClose}
      title="Discard Changes?"
      message="Are you sure you want to cancel? Any unsaved changes will be lost."
      confirmLabel="Discard"
      cancelLabel="Keep Editing"
      variant="warning"
      onConfirm={onClose}
      onCancel={() => setConfirmClose(false)}
    />
    </>
  );
}
