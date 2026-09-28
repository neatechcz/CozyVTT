import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CampaignMobileLayout from './CampaignMobileLayout';

describe('CampaignMobileLayout', () => {
  it('keeps the map, party and session available through touch sized tabs', () => {
    render(
      <CampaignMobileLayout
        party={<p>Party roster</p>}
        map={<p>Map canvas</p>}
        session={<p>Chat and dice</p>}
      />
    );

    expect(screen.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Map canvas')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Party' }));
    expect(screen.getByText('Party roster')).toBeVisible();
    expect(screen.getByText('Map canvas').closest('[role="tabpanel"]')).toHaveAttribute('hidden');
    fireEvent.click(screen.getByRole('tab', { name: 'Session' }));
    expect(screen.getByText('Chat and dice')).toBeVisible();
  });

  it('offers DM tools without covering the mobile session', () => {
    const onOpen = vi.fn();
    render(
      <CampaignMobileLayout
        party={<p>Party roster</p>}
        map={<p>Map canvas</p>}
        session={<p>Chat and dice</p>}
        dmTools={<button onClick={onOpen}>Map Library</button>}
      />
    );

    fireEvent.click(screen.getByText('DM tools'));
    fireEvent.click(screen.getByRole('button', { name: 'Map Library' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
