import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SessionToolbar from './SessionToolbar';

describe('SessionToolbar on touch screens', () => {
  it('shows tool names without relying on hover tooltips', () => {
    render(<SessionToolbar openPanels={{}} onOpen={vi.fn()} mobileLabels />);
    expect(screen.getByText('Map Library')).toBeInTheDocument();
    expect(screen.getByText('Campaign Settings')).toBeInTheDocument();
  });
});
