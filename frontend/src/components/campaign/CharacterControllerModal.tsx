import { useState } from 'react';

interface CharacterControllerModalProps {
  characterName: string;
  players: { userId: string; displayName: string }[];
  selectedUserId: string | null;
  saving: boolean;
  onSave: (userId: string | null) => void;
  onClose: () => void;
}

export default function CharacterControllerModal({ characterName, players, selectedUserId, saving, onSave, onClose }: CharacterControllerModalProps) {
  const [value, setValue] = useState(selectedUserId ?? '');
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
    <div role="dialog" aria-modal="true" aria-label={`Assign ${characterName} to player`}
      className="w-full max-w-md rounded-xl border border-moss-green/30 bg-soft-cream p-6 shadow-2xl">
      <h2 className="mb-2 text-xl font-semibold text-moss-green">Assign {characterName}</h2>
      <p className="mb-4 text-sm text-stone-gray">The selected player can edit the sheet, adjust HP, roll for this character, and move its map token.</p>
      <label className="mb-1 block text-sm font-medium text-stone-gray" htmlFor="character-controller">Player</label>
      <select className="input-cozy w-full" id="character-controller" value={value} onChange={(event) => setValue(event.target.value)}>
        <option value="">Nobody</option>
        {players.map((player) => <option key={player.userId} value={player.userId}>{player.displayName}</option>)}
      </select>
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className="rounded-lg px-4 py-2 text-sm text-stone-gray hover:bg-moss-green/10" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="rounded-lg bg-moss-green px-4 py-2 text-sm text-white disabled:opacity-50" onClick={() => onSave(value || null)} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  </div>;
}
