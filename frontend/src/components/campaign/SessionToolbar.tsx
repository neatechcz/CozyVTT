// ============================================
// Session Toolbar — grouped DM tools in the campaign header
// Replaces the row of seven identical labelled pill buttons with
// icon buttons in labelled groups (Content | Ambience | Settings),
// each with a tooltip. The open/close state still lives in
// CampaignPage — this is presentation only.
// ============================================

import {
  Map as MapIcon,
  Swords,
  BookOpen,
  Package,
  Ghost,
  Cloud,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import Tooltip from '@/components/ui/Tooltip';
import { cn } from '@/utils/cn';

export type SessionToolKey =
  | 'maps'
  | 'tokens'
  | 'creatures'
  | 'templates'
  | 'spirit'
  | 'atmosphere'
  | 'settings';

interface ToolDef {
  key: SessionToolKey;
  label: string;
  icon: LucideIcon;
}

// Grouped by intent: campaign content, scene ambience, configuration.
const TOOL_GROUPS: ToolDef[][] = [
  [
    { key: 'maps', label: 'Map Library', icon: MapIcon },
    { key: 'tokens', label: 'Token Manager', icon: Swords },
    { key: 'creatures', label: 'Creature Library', icon: BookOpen },
    { key: 'templates', label: 'Token Templates', icon: Package },
  ],
  [
    { key: 'spirit', label: 'Spirit Layer', icon: Ghost },
    { key: 'atmosphere', label: 'Atmosphere', icon: Cloud },
  ],
  [{ key: 'settings', label: 'Campaign Settings', icon: Settings }],
];

interface SessionToolbarProps {
  /** Which slide-over panels are currently open (drives the active state). */
  openPanels: Partial<Record<SessionToolKey, boolean>>;
  onOpen: (key: SessionToolKey) => void;
  /** Spirit layer active for the campaign — keeps the purple ring cue. */
  spiritLayerEnabled?: boolean;
  /** Keep tool names visible when there is no hover gesture. */
  mobileLabels?: boolean;
}

export default function SessionToolbar({
  openPanels,
  onOpen,
  spiritLayerEnabled = false,
  mobileLabels = false,
}: SessionToolbarProps) {
  return (
    <div className="flex items-center gap-1" role="toolbar" aria-label="DM tools">
      {TOOL_GROUPS.map((group, groupIndex) => (
        <div key={groupIndex} className="flex shrink-0 items-center gap-1">
          {groupIndex > 0 && <div className="h-6 w-px bg-moss-green/20 mx-1" aria-hidden="true" />}
          {group.map(({ key, label, icon }) => {
            const button = (
              <Button
                key={key}
                variant="ghost"
                iconOnly={!mobileLabels}
                icon={icon}
                aria-label={label}
                onClick={() => onOpen(key)}
                className={cn(
                  mobileLabels && 'flex min-h-14 min-w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-brand/20 bg-paper/60 px-2 py-1 text-center text-xs [&_svg]:!mr-0',
                  openPanels[key] && '!bg-accent/15 !text-accent',
                  key === 'spirit' && 'text-spirit-purple',
                  key === 'spirit' && spiritLayerEnabled && 'ring-2 ring-spirit-purple/50'
                )}
              >
                {mobileLabels && <span>{label}</span>}
              </Button>
            );
            return mobileLabels ? button : <Tooltip key={key} content={label} side="bottom">{button}</Tooltip>;
          })}
        </div>
      ))}
    </div>
  );
}
