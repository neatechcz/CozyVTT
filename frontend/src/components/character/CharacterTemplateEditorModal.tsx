/**
 * CharacterTemplateEditorModal
 * Edits a template's sheet using the same editor a character uses.
 *
 * A template holds the same `data` blob a Character does for the same game
 * system, so rather than build a second set of per-system forms, this wraps the
 * template in a Character-shaped object and hands it to CharacterSheetRouter.
 * The sheet cannot tell the difference, and every system is supported for free.
 */

import { useState } from 'react';
import { FileText } from 'lucide-react';
import api from '@/services/api';
import { useToast } from '@/contexts/ToastContext';
import type { Character, CharacterData, CharacterTemplate } from '@/types';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { CharacterSheetRouter } from '@/components/character-sheets/CharacterSheetRouter';

interface CharacterTemplateEditorModalProps {
  template: CharacterTemplate;
  onClose: () => void;
  onSaved: () => void;
}

export default function CharacterTemplateEditorModal({
  template,
  onClose,
  onSaved,
}: CharacterTemplateEditorModalProps) {
  const { showToast } = useToast();

  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');
  const [savingDetails, setSavingDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The template dressed as a Character so the existing sheets can render it.
   * Ids are the template's own — nothing here is ever persisted as a character.
   */
  const asCharacter: Character = {
    id: template.id,
    userId: template.createdById ?? '',
    campaignId: null,
    gameSystem: template.gameSystem,
    name: template.name,
    data: template.data as CharacterData,
    tokenImageUrl: template.tokenImageUrl,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };

  const handleSaveDetails = async () => {
    if (!name.trim()) {
      setError('A template name is required');
      return;
    }
    setSavingDetails(true);
    setError(null);
    try {
      await api.updateCharacterTemplate(template.id, {
        name: name.trim(),
        description: description.trim() || null,
      });
      showToast('Template updated', 'success');
      onSaved();
    } catch (err) {
      setError(
        (err as { response?: { data?: { message?: string } } }).response?.data?.message ??
          'Failed to update the template'
      );
    } finally {
      setSavingDetails(false);
    }
  };

  /** Sheet edits save straight through to the template's data blob. */
  const handleSheetSave = async (data: unknown) => {
    try {
      await api.updateCharacterTemplate(template.id, { data });
      showToast('Template sheet saved', 'success');
      onSaved();
    } catch (err) {
      showToast(
        (err as { response?: { data?: { message?: string } } }).response?.data?.message ??
          'Failed to save the sheet',
        'error'
      );
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit Template"
      icon={FileText}
      size="xl"
      closeDisabled={savingDetails}
    >
      <div className="space-y-6">
        <div className="space-y-4">
          <Field label="Template name" required error={error}>
            {(props) => (
              <Input
                {...props}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
              />
            )}
          </Field>

          <Field label="Description">
            {(props) => (
              <Textarea
                {...props}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={2000}
              />
            )}
          </Field>

          <div className="flex justify-end">
            <Button onClick={handleSaveDetails} loading={savingDetails}>
              Save Details
            </Button>
          </div>
        </div>

        <div className="border-t border-ink/10 pt-4">
          <h3 className="text-sm font-semibold text-brand-ink mb-3">Sheet</h3>
          <CharacterSheetRouter
            character={asCharacter}
            mode="edit"
            onSave={handleSheetSave}
            onCancel={onClose}
          />
        </div>
      </div>
    </Modal>
  );
}
