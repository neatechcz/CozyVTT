import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import Tooltip from './Tooltip';

describe('Tooltip', () => {
  it('mounts an end-aligned tooltip only while its trigger is active', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Hide session panel" delay={0} align="end">
        <button type="button">Hide session panel</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole('button', { name: 'Hide session panel' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.hover(trigger);
    const tooltip = await screen.findByRole('tooltip');
    expect(trigger.parentElement).toHaveAttribute('aria-describedby', tooltip.id);
    expect(tooltip).toHaveStyle({ right: '0px' });

    await user.unhover(trigger);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });
});
