/**
 * Sheet Reset Panel
 *
 * Lists the fields of a live D&D 5e sheet that the user had edited but that
 * someone else changed first — they were reset to the new value, and this
 * panel shows "mine → theirs" so the user can re-enter what they wanted.
 * Stays until closed; resets from several events accumulate.
 */

import { AlertTriangle, X } from 'lucide-react';
import type { SheetReset } from '@/hooks/useLiveCharacterSync';
import { getDnd5eFieldLabel } from '@/utils/dnd5eFieldLabels';

const MAX_VALUE_LENGTH = 120;

interface SheetResetPanelProps {
  resets: SheetReset[];
  onDismiss: () => void;
  /** Path → label; defaults to the D&D 5e labels */
  getLabel?: (path: string) => string;
}

/** Compact one-line rendering of a field value, at most 120 characters. */
export function formatResetValue(value: unknown): string {
  let text: string;
  if (value === undefined || value === null) {
    text = '—';
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

function groupByAuthor(resets: SheetReset[]) {
  const groups = new Map<string, { displayName: string; items: SheetReset[] }>();
  for (const reset of resets) {
    const key = reset.author.userId ?? `name:${reset.author.displayName}`;
    const group = groups.get(key);
    if (group) {
      group.items.push(reset);
    } else {
      groups.set(key, { displayName: reset.author.displayName, items: [reset] });
    }
  }
  return [...groups.entries()];
}

export default function SheetResetPanel({
  resets,
  onDismiss,
  getLabel = getDnd5eFieldLabel,
}: SheetResetPanelProps) {
  if (resets.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-sunset-orange/10 border border-sunset-orange/30 rounded-lg p-4 mb-4"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="flex items-center gap-2 font-semibold text-sunset-orange">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" />
          Tvé změny byly přepsány
        </h3>
        <button
          type="button"
          onClick={onDismiss}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-sm text-stone-gray hover:bg-sunset-orange/20 transition-colors"
        >
          <X className="w-4 h-4" aria-hidden="true" />
          Zavřít
        </button>
      </div>

      {groupByAuthor(resets).map(([key, group]) => (
        <section key={key} className="mt-2">
          <p className="text-sm font-medium text-stone-gray">Změnil(a): {group.displayName}</p>
          <ul className="mt-1 space-y-1">
            {group.items.map((reset, index) => (
              <li
                key={`${reset.path}-${reset.at}-${index}`}
                className="flex flex-wrap gap-x-2 text-sm"
              >
                <span className="font-medium text-moss-green">{getLabel(reset.path)}</span>
                <span className="font-mono text-stone-gray break-all">
                  {`${formatResetValue(reset.mine)} → ${formatResetValue(reset.theirs)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
