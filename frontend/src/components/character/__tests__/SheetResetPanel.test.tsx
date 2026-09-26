import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import SheetResetPanel, { formatResetValue } from '../SheetResetPanel';
import { getDnd5eFieldLabel } from '@/utils/dnd5eFieldLabels';
import type { SheetReset } from '@/hooks/useLiveCharacterSync';

const gm = { userId: 'gm', displayName: 'Pán jeskyně' };
const mira = { userId: 'mira', displayName: 'Míra' };

function reset(path: string, mine: unknown, theirs: unknown, author = gm): SheetReset {
  return { path, mine, theirs, author, at: 0 };
}

describe('getDnd5eFieldLabel', () => {
  it('maps common D&D 5e paths to Czech labels', () => {
    expect(getDnd5eFieldLabel('hp.current')).toBe('Aktuální HP');
    expect(getDnd5eFieldLabel('experiencePoints')).toBe('Zkušenosti');
    expect(getDnd5eFieldLabel('currency.gp')).toBe('Zlaťáky');
    expect(getDnd5eFieldLabel('inventory')).toBe('Inventář');
    expect(getDnd5eFieldLabel('conditions')).toBe('Stavy');
    expect(getDnd5eFieldLabel('spellcasting.slots.1.expended')).toBe('Použité sloty 1. úrovně');
    expect(getDnd5eFieldLabel('spellcasting.slots.3.expended')).toBe('Použité sloty 3. úrovně');
  });

  it('labels the whole-document path', () => {
    expect(getDnd5eFieldLabel('')).toBe('Celý list postavy');
  });

  it('falls back to the raw path', () => {
    expect(getDnd5eFieldLabel('some.unknown.path')).toBe('some.unknown.path');
  });
});

describe('formatResetValue', () => {
  it('renders primitives plainly and empties as a dash', () => {
    expect(formatResetValue(5)).toBe('5');
    expect(formatResetValue('otráven')).toBe('otráven');
    expect(formatResetValue(true)).toBe('true');
    expect(formatResetValue(undefined)).toBe('—');
    expect(formatResetValue(null)).toBe('—');
  });

  it('stringifies arrays and objects compactly', () => {
    expect(formatResetValue(['prone', 'poisoned'])).toBe('["prone","poisoned"]');
    expect(formatResetValue({ gp: 1 })).toBe('{"gp":1}');
  });

  it('truncates long values at 120 characters', () => {
    const long = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const formatted = formatResetValue(long);
    expect(formatted.length).toBe(120);
    expect(formatted.endsWith('…')).toBe(true);
  });
});

describe('SheetResetPanel', () => {
  it('renders nothing without resets', () => {
    const { container } = render(<SheetResetPanel resets={[]} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists resets grouped by author with labels and mine → theirs', () => {
    render(
      <SheetResetPanel
        resets={[
          reset('hp.current', 5, 3),
          reset('inventory', [{ name: 'Rope' }], []),
          reset('currency.gp', 10, 12, mira),
          reset('custom.field', 'a', 'b'),
        ]}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Tvé změny byly přepsány')).toBeInTheDocument();

    const gmGroup = screen.getByText('Změnil(a): Pán jeskyně').closest('section')!;
    expect(within(gmGroup).getByText('Aktuální HP')).toBeInTheDocument();
    expect(within(gmGroup).getByText('5 → 3')).toBeInTheDocument();
    expect(within(gmGroup).getByText('Inventář')).toBeInTheDocument();
    expect(within(gmGroup).getByText('[{"name":"Rope"}] → []')).toBeInTheDocument();
    expect(within(gmGroup).getByText('custom.field')).toBeInTheDocument();
    expect(within(gmGroup).queryByText('Zlaťáky')).not.toBeInTheDocument();

    const miraGroup = screen.getByText('Změnil(a): Míra').closest('section')!;
    expect(within(miraGroup).getByText('Zlaťáky')).toBeInTheDocument();
    expect(within(miraGroup).getByText('10 → 12')).toBeInTheDocument();
  });

  it('calls onDismiss from the close button', () => {
    const onDismiss = vi.fn();
    render(<SheetResetPanel resets={[reset('hp.current', 5, 3)]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zavřít' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
