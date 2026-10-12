// @vitest-environment jsdom
/**
 * The storage format conversion's corner chip (Plan B, Task 9). The daemon's
 * job reports by `format-migration-progress`; the chip renders what it says,
 * offers Pause / Resume / Cancel, says why a run stopped in catalog words,
 * and is never a modal.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('framer-motion', () => {
  const div = React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) =>
    React.createElement('div', { ...props, ref }, children));
  return { motion: { div }, AnimatePresence: ({ children }) => children };
});

// The daemon's routes are the boundary; failureText stays real.
const get = vi.fn();
const pause = vi.fn();
const resume = vi.fn();
const cancel = vi.fn();
let progress = null;
let reconnected = null;
vi.mock('../../services/storageFormat', async (importOriginal) => ({
  ...(await importOriginal()),
  get: (...a) => get(...a),
  pause: (...a) => pause(...a),
  resume: (...a) => resume(...a),
  cancel: (...a) => cancel(...a),
  onProgress: (cb) => { progress = cb; return Promise.resolve(() => { if (progress === cb) progress = null; }); },
  onDaemonReconnected: (cb) => { reconnected = cb; return Promise.resolve(() => {}); },
}));

const { FormatMigrationProgress, face } = await import('../FormatMigrationProgress');
const { failureText } = await import('../../services/storageFormat');

const job = (over) => ({ jobId: 'j1', to: 'jmap', oldFiles: 'retire', state: 'running', active: true, done: 5, total: 10, failed: 0, error: null, ...over });
const chip = () => screen.queryByTestId('format-migration-job');

beforeEach(() => {
  progress = null;
  reconnected = null;
  get.mockReset().mockResolvedValue({ format: 'maildir', migration: null });
  pause.mockReset().mockResolvedValue({ jobId: 'j1', paused: true });
  resume.mockReset().mockResolvedValue({ jobId: 'j1', resumed: true });
  cancel.mockReset().mockResolvedValue({ jobId: 'j1', cancelled: true });
});
afterEach(cleanup);

describe('the format conversion chip', () => {
  it('shows nothing without a conversion', async () => {
    render(<FormatMigrationProgress />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(progress).toBeTypeOf('function'));
    expect(chip()).toBeNull();
  });

  it('shows a running conversion with its counts, Pause and Cancel, and follows its events', async () => {
    get.mockResolvedValue({ format: 'jmap', migration: job() });
    render(<FormatMigrationProgress />);
    await waitFor(() => expect(chip()?.dataset.state).toBe('running'));
    expect(screen.getByRole('status').textContent).toBe('Converting message format');
    expect(screen.getByTestId('format-migration-counts').textContent).toBe('5 of 10 messages');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    expect(screen.queryByTestId('format-migration-resume')).toBeNull();

    fireEvent.click(screen.getByTestId('format-migration-pause'));
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(progress).toBeTypeOf('function'));
    act(() => progress(job({ state: 'paused', done: 7 })));
    expect(chip().dataset.state).toBe('paused');
    expect(screen.getByRole('status').textContent).toBe('Message format conversion paused');
    expect(screen.getByTestId('format-migration-counts').textContent).toBe('7 of 10 messages');
    fireEvent.click(screen.getByTestId('format-migration-resume'));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('format-migration-cancel'));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it('shows a run a restart cut off as paused, with Resume', async () => {
    get.mockResolvedValue({ format: 'jmap', migration: job({ state: 'paused', active: false }) });
    render(<FormatMigrationProgress />);
    await waitFor(() => expect(chip()?.dataset.state).toBe('paused'));
    expect(screen.getByTestId('format-migration-resume')).toBeTruthy();
    expect(screen.queryByTestId('format-migration-pause')).toBeNull();
  });

  it('says why a run stopped in catalog words, offers Resume, and closes', async () => {
    get.mockResolvedValue({ format: 'jmap', migration: job({ state: 'failed', active: false, done: 9, failed: 3, error: 'E_FORMAT_UNVERIFIED: 3' }) });
    render(<FormatMigrationProgress />);
    await waitFor(() => expect(chip()?.dataset.state).toBe('failed'));
    expect(screen.getByRole('status').textContent).toBe('Message format conversion stopped');
    expect(screen.getByText('Conversion stopped: some messages did not verify (3). Nothing was deleted for the messages that failed.')).toBeTruthy();
    expect(screen.queryByTestId('format-migration-cancel')).toBeNull();
    fireEvent.click(screen.getByTestId('format-migration-resume'));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('format-migration-close'));
    expect(chip()).toBeNull();
  });

  it('says when it is done, until closed; a cancelled run shows nothing', async () => {
    render(<FormatMigrationProgress />);
    await waitFor(() => expect(progress).toBeTypeOf('function'));
    act(() => progress(job({ state: 'done', active: false, done: 10 })));
    expect(chip().dataset.state).toBe('done');
    expect(screen.getByRole('status').textContent).toBe('Message format converted');
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByTestId('format-migration-close'));
    expect(chip()).toBeNull();

    act(() => progress(job({ jobId: 'j2', state: 'cancelled', active: false })));
    expect(chip()).toBeNull();
  });

  it('asks the daemon again when it comes back', async () => {
    render(<FormatMigrationProgress />);
    await waitFor(() => expect(reconnected).toBeTypeOf('function'));
    get.mockResolvedValue({ format: 'jmap', migration: job({ state: 'paused', active: false }) });
    await act(async () => { reconnected(); });
    await waitFor(() => expect(chip()?.dataset.state).toBe('paused'));
  });
});

describe('face and failureText', () => {
  it('reads the face off the daemon state', () => {
    expect([null, job(), job({ active: false }), job({ state: 'paused' }), job({ state: 'failed' }), job({ state: 'done' }), job({ state: 'cancelled' })].map(face))
      .toEqual([null, 'running', null, 'paused', 'failed', 'done', null]);
  });

  it('maps the daemon codes to catalog words', () => {
    expect(failureText('E_FORMAT_REHOME_PENDING: 2')).toBe('some folders wait for their first full sync (2)');
    expect(failureText('E_FORMAT_DISK: see the daemon log')).toBe('the disk is full or failing');
    expect(failureText('E_FORMAT_UNREADABLE: see the daemon log')).toBe('a folder of the vault could not be read');
    expect(failureText('E_FORMAT_DAMAGED: 2')).toBe('some message records are damaged and were left as they are (2)');
    expect(failureText('No space left on device')).toBe('No space left on device');
    expect(failureText(null)).toBe('');
  });
});
