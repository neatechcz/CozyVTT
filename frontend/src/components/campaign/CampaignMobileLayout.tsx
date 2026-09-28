import { useState, type ReactNode } from 'react';
import { Map, Users, MessageCircle } from 'lucide-react';
import { cn } from '@/utils/cn';

type MobilePanel = 'map' | 'party' | 'session';

interface CampaignMobileLayoutProps {
  map: ReactNode;
  party: ReactNode;
  session: ReactNode;
  dmTools?: ReactNode;
}

const tabs = [
  { id: 'map', label: 'Map', icon: Map },
  { id: 'party', label: 'Party', icon: Users },
  { id: 'session', label: 'Session', icon: MessageCircle },
] as const;

export default function CampaignMobileLayout({ map, party, session, dmTools }: CampaignMobileLayoutProps) {
  const [active, setActive] = useState<MobilePanel>('map');
  const panels = { map, party, session };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {dmTools && (
        <details className="shrink-0 border-b border-brand/20 bg-surface/90 px-3 py-2">
          <summary className="cursor-pointer select-none rounded-lg px-2 py-1 text-sm font-semibold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
            DM tools
          </summary>
          <div className="mt-2 max-w-full overflow-x-auto pb-1">{dmTools}</div>
        </details>
      )}
      <nav className="grid shrink-0 grid-cols-3 border-b border-brand/20 bg-surface/90" role="tablist" aria-label="Campaign panels">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            id={`mobile-campaign-tab-${id}`}
            role="tab"
            aria-controls={`mobile-campaign-panel-${id}`}
            aria-selected={active === id}
            onClick={() => setActive(id)}
            className={cn(
              'flex min-h-12 items-center justify-center gap-2 px-2 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand',
              active === id ? 'border-b-2 border-brand bg-paper text-brand' : 'text-ink-secondary hover:bg-brand/10'
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
      {tabs.map(({ id }) => (
        <div
          key={id}
          id={`mobile-campaign-panel-${id}`}
          role="tabpanel"
          aria-labelledby={`mobile-campaign-tab-${id}`}
          hidden={active !== id}
          className="min-h-0 min-w-0 flex-1"
        >
          {panels[id]}
        </div>
      ))}
    </div>
  );
}
