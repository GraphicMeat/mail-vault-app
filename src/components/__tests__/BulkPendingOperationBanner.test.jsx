// @vitest-environment jsdom
import React, { useState } from 'react';
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  act,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
const m = vi.hoisted(() => ({
  listeners: new Set(),
  status: vi.fn(),
  resume: vi.fn(),
  discard: vi.fn(),
  setState: vi.fn(),
}));
vi.mock('../../services/BulkOperationManager', () => ({
  bulkOperationManager: {
    subscribe: (listener) => {
      m.listeners.add(listener);
      return () => m.listeners.delete(listener);
    },
    status: (...args) => m.status(...args),
    resume: (...args) => m.resume(...args),
    discard: (...args) => m.discard(...args),
  },
}));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: { setState: (...args) => m.setState(...args) },
}));
import { BulkPendingOperationBanner } from '../BulkPendingOperationBanner';
function AppPendingHost() {
  const [pending, setPending] = useState(null);
  return (
    <BulkPendingOperationBanner
      pending={pending}
      onPendingChange={setPending}
    />
  );
}
beforeEach(() => {
  m.listeners.clear();
  m.status.mockReset();
  m.resume.mockReset().mockResolvedValue(null);
  m.discard.mockReset().mockResolvedValue(null);
  m.setState.mockReset();
});
afterEach(cleanup);
it.each(['awaitingResume', 'error'])(
  'offers an exact native pending choice after live %s without restart',
  async (status) => {
    const pending = {
      id: 'native-pending-A',
      attemptId: 'attempt-A',
      type: 'delete_everywhere',
      status: 'awaitingResume',
      remaining: 2,
    };
    m.status.mockResolvedValue({ active: null, pending });
    m.discard.mockImplementation(async () => {
      m.status.mockResolvedValue({ active: null, pending: null });
    });
    render(<AppPendingHost />);
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    act(() => {
      for (const listener of m.listeners)
        listener({ ...pending, status }, { settled: true });
    });
    const resume = await screen.findByRole('button', { name: 'Resume' });
    expect(m.resume).not.toHaveBeenCalled();
    fireEvent.click(resume);
    await waitFor(() =>
      expect(m.resume).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'native-pending-A',
          attemptId: 'attempt-A',
        }),
        null,
        expect.any(Function)
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(m.discard).toHaveBeenCalledWith('native-pending-A')
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    );
  }
);
