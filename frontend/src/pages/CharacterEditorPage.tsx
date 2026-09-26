// ============================================
// Character Editor Page
// Allows editing characters for any game system
// ============================================

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, AlertCircle, Loader2, Lock, Download, WifiOff } from 'lucide-react';
import CharacterSheetSkeleton from '@/components/skeletons/CharacterSheetSkeleton';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import characterService from '@/services/character.service';
import campaignService from '@/services/campaign.service';
import { canEditCharacter } from '@/services/permissions';
import { CharacterSheetRouter } from '@/components/character-sheets/CharacterSheetRouter';
import SheetResetPanel from '@/components/character/SheetResetPanel';
import { useLiveCharacterSync, type LiveSyncSocket } from '@/hooks/useLiveCharacterSync';
import { buildDnd5eFormData } from '@/components/character-sheets/dnd5e/dnd5eFormData';
import socketClient from '@/services/socket';
import { GameSystem, type Character, type Campaign } from '@/types';
import Button from '@/components/ui/Button';

/** Backoff between attempts to open the live connection; the last repeats */
const LIVE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];

export default function CharacterEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showToast } = useToast();

  // State
  const [character, setCharacter] = useState<Character | null>(null);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  // Auto-save timer ref
  const autoSaveTimerRef = useRef<number | null>(null);
  const pendingDataRef = useRef<any>(null);

  // Live sync (D&D 5e only): remote changes flow into the open editor, saves
  // send only the changed fields. This page is outside the campaign's
  // WebSocketProvider, so it connects the shared socket client itself —
  // quietly, so opening the editor posts no "has joined the campaign".
  const isDnd5e = character?.gameSystem === GameSystem.DND_5E;
  const liveCampaignId =
    isDnd5e && !loading && !permissionError ? character?.campaignId ?? null : null;
  const [liveStatus, setLiveStatus] = useState<'connecting' | 'live' | 'offline'>('connecting');
  // Bumped whenever the client creates a new underlying socket. The client
  // re-attaches listeners added through socketClient.on() by itself; the hook
  // resubscribing on a new generation is a harmless off/on of one handler.
  const [socketGeneration, setSocketGeneration] = useState(0);
  const liveSocket = useMemo<(LiveSyncSocket & { generation: number }) | null>(
    () =>
      liveCampaignId
        ? {
            // A new object per socket generation makes the hook subscribe again
            generation: socketGeneration,
            on: (event, callback) => socketClient.on(event, callback),
            off: (event, callback) => socketClient.off(event, callback),
          }
        : null,
    [liveCampaignId, socketGeneration],
  );

  const liveSync = useLiveCharacterSync({
    character,
    socket: liveSocket,
    isDnd5e,
    onServerCharacter: setCharacter,
    normalizeForm: buildDnd5eFormData,
  });
  const { refresh: refreshLiveCharacter } = liveSync;

  useEffect(() => {
    if (!liveCampaignId) return;

    let active = true;
    let retryTimer: number | undefined;
    let retries = 0;
    let warned = false;
    const isOurCampaign = () => socketClient.getCampaignId() === liveCampaignId;
    // Already connected to this campaign (e.g. from the campaign page): reuse
    // it as is and leave it connected afterwards
    const openedHere = !(socketClient.isConnected() && isOurCampaign());

    const scheduleRetry = () => {
      if (!openedHere || retryTimer !== undefined) return;
      const delay = LIVE_RETRY_DELAYS_MS[Math.min(retries, LIVE_RETRY_DELAYS_MS.length - 1)];
      retries += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        if (active) connectLive();
      }, delay);
    };

    const connectLive = () => {
      socketClient
        .connect(liveCampaignId, { quiet: true })
        .then(() => {
          if (active) setLiveStatus('live');
        })
        .catch((err) => {
          if (!active) return;
          // Not critical — saves still detect conflicts via PATCH
          if (!warned) console.warn('Live character updates unavailable:', err);
          warned = true;
          setLiveStatus('offline');
          // A socket that still exists is retried by socket.io itself; its
          // rejoin signals 'authenticated'. Otherwise try again later.
          if (!(isOurCampaign() && socketClient.getSocket())) scheduleRetry();
        });
    };

    const unsubscribe = socketClient.onLifecycle((event) => {
      if (!active) return;
      if (event === 'replaced') {
        setSocketGeneration((generation) => generation + 1);
        return;
      }
      if (!isOurCampaign()) return;
      if (event === 'authenticated') {
        retries = 0;
        warned = false;
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
        setLiveStatus('live');
        // Catch up on anything whose broadcast was missed (before the join
        // or while disconnected); merged like any remote change
        refreshLiveCharacter().catch((err) => {
          if (active) console.warn('Failed to reload the character after joining:', err);
        });
      } else if (event === 'disconnected') {
        setLiveStatus('offline');
      } else if (event === 'failed') {
        setLiveStatus('offline');
        scheduleRetry();
      }
    });

    if (openedHere) {
      setLiveStatus('connecting');
      connectLive();
    } else {
      setLiveStatus('live');
    }

    return () => {
      active = false;
      window.clearTimeout(retryTimer);
      unsubscribe();
      if (openedHere) socketClient.disconnect();
    };
  }, [liveCampaignId, refreshLiveCharacter]);

  const unsavedChanges = isDnd5e ? liveSync.isDirty : hasUnsavedChanges;

  // ============================================
  // Fetch Character & Check Permissions
  // ============================================

  useEffect(() => {
    if (!id || !user) return;

    const fetchCharacter = async () => {
      try {
        setLoading(true);
        setError(null);
        setPermissionError(null);

        // Fetch character
        const fetchedCharacter = await characterService.getCharacter(id);
        setCharacter(fetchedCharacter);

        // Check permissions
        const canEdit = await checkEditPermission(fetchedCharacter);
        if (!canEdit) {
          setPermissionError(
            'You do not have permission to edit this character. Only the owner or the DM of the assigned campaign can edit characters.'
          );
          return;
        }

        // Fetch campaign if character is assigned
        if (fetchedCharacter.campaignId) {
          try {
            const fetchedCampaign = await campaignService.getCampaign(
              fetchedCharacter.campaignId
            );
            setCampaign(fetchedCampaign);
          } catch (err) {
            console.warn('Failed to fetch campaign:', err);
            // Not critical - continue without campaign data
          }
        }
      } catch (err: any) {
        console.error('Failed to fetch character:', err);
        setError(err.message || 'Failed to load character');
      } finally {
        setLoading(false);
      }
    };

    fetchCharacter();
  }, [id, user]);

  // ============================================
  // Permission Check
  // ============================================

  const checkEditPermission = async (char: Character): Promise<boolean> => {
    if (!user) return false;

    // User owns the character
    if (char.userId === user.id) {
      return true;
    }

    // Character is assigned to a campaign - check if user is the DM
    if (char.campaignId) {
      try {
        const camp = await campaignService.getCampaign(char.campaignId);
        const membership = camp.memberships?.find(
          (candidate) => candidate.userId === user.id,
        );
        return canEditCharacter(user, char, membership);
      } catch (err) {
        console.error('Failed to check campaign permission:', err);
      }
    }

    return false;
  };

  // ============================================
  // Save Handler
  // ============================================

  const handleSave = useCallback(
    async (data: any, doShowToast = true, tokenImageUrl?: string) => {
      if (!character) return;

      try {
        setSaving(true);

        if (isDnd5e) {
          // Field-level PATCH of the live form (the store's atomic snapshot,
          // not `data`); conflicts land in the panel
          const outcome = await liveSync.save();

          // The token image is not part of `data` — persist it separately
          if (tokenImageUrl !== undefined) {
            const updated = await characterService.updateCharacter(character.id, { tokenImageUrl });
            setCharacter(updated);
          }

          if (outcome.status === 'stale') {
            // Nothing was written: the newer sheet is merged into the form
            showToast(outcome.message, 'warning');
            return;
          }

          setLastSaved(new Date());
          pendingDataRef.current = null;

          if (outcome.status === 'conflicts') {
            showToast('Některé změny kolidovaly — viz panel', 'warning');
          } else if (doShowToast) {
            showToast('Character saved!', 'success');
          }
          return;
        }

        // Update character via API
        // Use the new tokenImageUrl if provided, otherwise keep the existing one
        const updated = await characterService.updateCharacter(character.id, {
          name: character.name,
          data,
          tokenImageUrl: tokenImageUrl !== undefined ? tokenImageUrl : (character.tokenImageUrl || undefined),
        });

        // Update local state
        setCharacter(updated);
        setHasUnsavedChanges(false);
        setLastSaved(new Date());
        pendingDataRef.current = null;

        if (doShowToast) {
          showToast('Character saved!', 'success');
        }
      } catch (err: any) {
        console.error('Failed to save character:', err);
        console.error('Error response:', err.response?.data);

        // Show detailed validation errors if available
        if (err.response?.data?.validationErrors) {
          const validationErrors = err.response.data.validationErrors;
          const errorMessages = validationErrors.map((e: any) => `${e.path}: ${e.message}`).join('\n');
          setError(`Validation errors:\n${errorMessages}`);
          console.error('Validation errors:', validationErrors);
        } else {
          setError(err.response?.data?.message || err.message || 'Failed to save character');
        }
      } finally {
        setSaving(false);
      }
    },
    [character, isDnd5e, liveSync.save]
  );

  // ============================================
  // Character Sheet Save Handler (called by bottom save button)
  // ============================================

  const handleSheetSave = useCallback(
    async (data: any, showToast?: boolean, tokenImageUrl?: string) => {
      // Log the data being saved for debugging
      console.log('Saving character data:', data);

      // Save immediately when user clicks save in character sheet
      // Pass tokenImageUrl through so token images are persisted
      await handleSave(data, showToast ?? true, tokenImageUrl);

      // Store for top save button reference. Not for D&D 5e: live sync keeps
      // the form current, so replaying this snapshot could PATCH old values back.
      if (!isDnd5e) {
        pendingDataRef.current = data;
      }
    },
    [handleSave, isDnd5e]
  );

  // ============================================
  // Cleanup Auto-save Timer
  // ============================================

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, []);

  // ============================================
  // Unsaved Changes Warning
  // ============================================

  // Warn user before closing/refreshing page
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [unsavedChanges]);

  // ============================================
  // Navigation Handlers
  // ============================================

  const handleBack = () => {
    if (unsavedChanges) {
      setConfirmLeave(true);
      return;
    }
    navigate('/characters');
  };

  const handleCancel = () => {
    handleBack();
  };

  // ============================================
  // Manual Save Handler
  // ============================================

  const handleManualSave = async () => {
    if (!isDnd5e && pendingDataRef.current) {
      await handleSave(pendingDataRef.current, true);
    }
  };

  // ============================================
  // Render
  // ============================================

  // Loading state — full-page skeleton
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-soft-cream via-parchment to-warm-amber/20">
        <CharacterSheetSkeleton />
      </div>
    );
  }

  // Error state
  if (error || !character) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-soft-cream via-parchment to-warm-amber/20 p-4">
        <div className="glass-panel p-8 max-w-md w-full text-center">
          <AlertCircle className="w-12 h-12 text-spirit-red mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-moss-green mb-2">
            Failed to Load Character
          </h2>
          <p className="text-stone-gray mb-6">{error || 'Character not found'}</p>
          <Button onClick={() => navigate('/characters')}>
            Back to Characters
          </Button>
        </div>
      </div>
    );
  }

  // Permission denied state
  if (permissionError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-soft-cream via-parchment to-warm-amber/20 p-4">
        <div className="glass-panel p-8 max-w-md w-full text-center">
          <Lock className="w-12 h-12 text-sunset-orange mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-moss-green mb-2">
            Permission Denied
          </h2>
          <p className="text-stone-gray mb-6">{permissionError}</p>
          <Button onClick={() => navigate('/characters')}>
            Back to Characters
          </Button>
        </div>
      </div>
    );
  }

  // Main editor
  return (
    <>
    <ConfirmDialog
      isOpen={confirmLeave}
      title="Unsaved Changes"
      message="You have unsaved changes. Are you sure you want to leave? Your changes will be lost."
      confirmLabel="Leave"
      cancelLabel="Stay"
      variant="warning"
      onConfirm={() => navigate('/characters')}
      onCancel={() => setConfirmLeave(false)}
    />
    <div className="min-h-screen bg-gradient-to-br from-soft-cream via-parchment to-warm-amber/20">
      {/* Header */}
      <div className="glass-panel m-4 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={handleBack}
              className="p-2 rounded-lg hover:bg-moss-green/10 transition-colors"
              aria-label="Back to characters"
            >
              <ArrowLeft className="w-5 h-5 text-moss-green" />
            </button>
            <div>
              <h1 className="text-2xl font-bold text-moss-green">
                Editing: {character.name}
              </h1>
              {campaign && (
                <p className="text-sm text-stone-gray">
                  Campaign: {campaign.name}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Save Status */}
            {unsavedChanges && (
              <span className="text-sm text-sunset-orange">Unsaved changes</span>
            )}
            {saving && (
              <span className="text-sm text-moss-green flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </span>
            )}
            {lastSaved && !unsavedChanges && (
              <span className="text-sm text-stone-gray">
                Saved {lastSaved.toLocaleTimeString()}
              </span>
            )}

            {/* Manual Save Button (D&D 5e saves from the sheet itself) */}
            {!isDnd5e && (
              <Button
                onClick={handleManualSave}
                disabled={!hasUnsavedChanges || saving}
                className="flex items-center gap-2"
              >
                <Save className="w-4 h-4" />
                Save
              </Button>
            )}

            {/* Export Button */}
            <Button
              onClick={() => characterService.exportCharacterJSON(character)}
              variant="secondary" className="flex items-center gap-2"
              title="Export character as JSON"
            >
              <Download className="w-4 h-4" />
              Export
            </Button>
          </div>
        </div>
      </div>

      {/* Character Sheet Editor */}
      <div className="p-4">
        {liveCampaignId && liveStatus === 'offline' && (
          <div
            role="status"
            className="glass-panel mb-4 p-3 text-sm text-sunset-orange flex items-center gap-2"
          >
            <WifiOff className="w-4 h-4 shrink-0" />
            Živé změny nejsou dostupné — změny ostatních se zobrazí po obnovení spojení.
          </div>
        )}
        {isDnd5e && (
          <SheetResetPanel resets={liveSync.resets} onDismiss={liveSync.dismissResets} />
        )}
        <CharacterSheetRouter
          character={character}
          mode="edit"
          onSave={handleSheetSave}
          onCancel={handleCancel}
          {...(isDnd5e
            ? {
                formStore: liveSync.formStore,
              }
            : {})}
        />
      </div>
    </div>
    </>
  );
}
