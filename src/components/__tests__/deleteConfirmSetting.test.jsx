// @vitest-environment jsdom
//
// "Settings needs an option to either display a modal when deleting emails or
// not" (2026-09-21). The choice is honoured in DeleteConfirmModal, the one
// component all seven delete verbs are already routed through — and only a
// delete that can be taken back opts in with `confirmOptional`. A purge, and
// removing the vault's only copy, keep asking: nothing there is recoverable.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))), has: () => true });
});

import { DeleteConfirmModal } from '../DeleteConfirmModal';
import { useSettingsStore } from '../../stores/settingsStore';

const copy = { title: 'Delete from server?', description: 'It leaves the server.', confirmLabel: 'Delete' };

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ confirmBeforeDelete: true });
});

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('confirmBeforeDelete', () => {
  it('defaults to asking', () => {
    expect(useSettingsStore.getState().confirmBeforeDelete).toBe(true);
  });

  it('shows the confirm when it is on', () => {
    const executor = vi.fn();
    render(<DeleteConfirmModal pending={{ executor, copy, confirmOptional: true }} onClose={vi.fn()} />);
    expect(screen.getByText('Delete from server?')).toBeTruthy();
    expect(executor).not.toHaveBeenCalled();
  });

  it('deletes without a confirm when it is off', async () => {
    useSettingsStore.setState({ confirmBeforeDelete: false });
    const executor = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const { container } = render(<DeleteConfirmModal pending={{ executor, copy, confirmOptional: true }} onClose={onClose} />);
    await flush();
    expect(container.innerHTML).toBe('');
    expect(screen.queryByText('Delete from server?')).toBeNull();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still asks for a delete nothing can take back', async () => {
    useSettingsStore.setState({ confirmBeforeDelete: false });
    const executor = vi.fn();
    render(<DeleteConfirmModal pending={{ executor, copy: { ...copy, title: 'Delete everywhere?' } }} onClose={vi.fn()} />);
    await flush();
    expect(screen.getByText('Delete everywhere?')).toBeTruthy();
    expect(executor).not.toHaveBeenCalled();
  });

  it('runs a second delete raised by the same mount', async () => {
    useSettingsStore.setState({ confirmBeforeDelete: false });
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<DeleteConfirmModal pending={{ executor: first, copy, confirmOptional: true }} onClose={vi.fn()} />);
    await flush();
    rerender(<DeleteConfirmModal pending={null} onClose={vi.fn()} />);
    rerender(<DeleteConfirmModal pending={{ executor: second, copy, confirmOptional: true }} onClose={vi.fn()} />);
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

// A store that has not answered yet — a stub in a spec, a rehydrate in flight —
// is not permission to delete on the click.
it('asks when the setting is missing entirely', async () => {
  useSettingsStore.setState({ confirmBeforeDelete: undefined });
  const executor = vi.fn();
  render(<DeleteConfirmModal pending={{ executor, copy, confirmOptional: true }} onClose={vi.fn()} />);
  await flush();
  expect(screen.getByText('Delete from server?')).toBeTruthy();
  expect(executor).not.toHaveBeenCalled();
});
