// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The daemon's routes are the boundary; errorMessage stays real, so a refusal
// reads as its catalog sentence.
const get = vi.fn();
const retired = vi.fn();
const convert = vi.fn();
const pause = vi.fn();
const resume = vi.fn();
const cancel = vi.fn();
const purgeRetired = vi.fn();
const reclaimSpace = vi.fn();
let progress = null;
vi.mock('../../../services/storageFormat', async (importOriginal) => ({
  ...(await importOriginal()),
  get: (...a) => get(...a),
  retired: (...a) => retired(...a),
  convert: (...a) => convert(...a),
  pause: (...a) => pause(...a),
  resume: (...a) => resume(...a),
  cancel: (...a) => cancel(...a),
  purgeRetired: (...a) => purgeRetired(...a),
  reclaimSpace: (...a) => reclaimSpace(...a),
  onProgress: (cb) => { progress = cb; return Promise.resolve(() => { if (progress === cb) progress = null; }); },
  onDaemonReconnected: () => Promise.resolve(() => {}),
}));

import { StorageFormatSettings } from '../StorageFormatSettings';
import { formatBytes } from '../../../utils/formatBytes';

const GB = 1024 * 1024 * 1024;
const MAILDIR = { format: 'maildir', migration: null };
const JMAP = { format: 'jmap', migration: null };
const job = (over) => ({ jobId: 'j1', to: 'jmap', oldFiles: 'retire', state: 'running', active: true, done: 5, total: 10, failed: 0, error: null, ...over });

const dialog = () => screen.getByRole('dialog');
const radio = (value) => dialog().querySelector(`input[type="radio"][value="${value}"]`);

beforeEach(() => {
  progress = null;
  get.mockReset().mockResolvedValue(MAILDIR);
  retired.mockReset().mockResolvedValue({ bytes: 0, count: 0 });
  convert.mockReset().mockResolvedValue({ jobId: 'j2' });
  pause.mockReset().mockResolvedValue({ jobId: 'j1', paused: true });
  resume.mockReset().mockResolvedValue({ jobId: 'j1', resumed: true });
  cancel.mockReset().mockResolvedValue({ jobId: 'j1', cancelled: true });
  purgeRetired.mockReset().mockResolvedValue({ bytes: 0, count: 0 });
  reclaimSpace.mockReset().mockResolvedValue({ removed: 0, bytes: 0 });
});
afterEach(cleanup);

describe('Settings > Storage > Message format', () => {
  it('shows the current format, and the Convert dialog keeps old files aside by default', async () => {
    render(<StorageFormatSettings usage={{ totalBytes: 2 * GB, emailCount: 1200 }} />);
    await waitFor(() => expect(screen.getByTestId('storage-format-current').textContent).toBe('Maildir (.eml files)'));
    expect(screen.queryByText('Reclaim space')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(within(dialog()).getByText('Convert to JMAP (JSON records + blobs)')).toBeTruthy();
    expect(within(dialog()).getByTestId('storage-format-estimate').textContent).toBe(`${formatBytes(2 * GB)} (1,200 emails saved)`);
    expect(radio('retire').checked).toBe(true);
    expect(radio('delete').checked).toBe(false);

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Start conversion' }));
    await waitFor(() => expect(convert).toHaveBeenCalledWith('jmap', 'retire'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('deletes old files only when picked, and a reopened dialog is back on keeping them', async () => {
    render(<StorageFormatSettings usage={null} />);
    await waitFor(() => screen.getByRole('button', { name: 'Convert' }));

    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    fireEvent.click(radio('delete'));
    expect(radio('delete').checked).toBe(true);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(convert).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(radio('retire').checked).toBe(true);
    expect(radio('delete').checked).toBe(false);

    expect(within(dialog()).getByText('Delete old files after each message is verified')).toBeTruthy();
    fireEvent.click(radio('delete'));
    expect(radio('delete').checked).toBe(true);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Start conversion' }));
    await waitFor(() => expect(convert).toHaveBeenCalledWith('jmap', 'delete'));
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('asks before deleting the old files, naming their size', async () => {
    const bytes = Math.round(3.2 * GB);
    retired.mockResolvedValue({ bytes, count: 40 });
    render(<StorageFormatSettings usage={null} />);
    const size = formatBytes(bytes);
    await waitFor(() => expect(screen.getByTestId('storage-format-retired').textContent).toBe(`Old files kept aside: ${size}`));

    fireEvent.click(screen.getByRole('button', { name: 'Delete old files' }));
    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByText(`Permanently delete ${size} of old message files? Your converted mail is not affected.`)).toBeTruthy();
    expect(purgeRetired).not.toHaveBeenCalled();

    retired.mockResolvedValue({ bytes: 0, count: 0 });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(purgeRetired).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('storage-format-retired')).toBeNull());
  });

  it('a cancelled conversion shows where it stopped, with Resume and Convert back', async () => {
    get.mockResolvedValue({ format: 'jmap', migration: job({ state: 'cancelled', active: false, done: 40, total: 100 }) });
    render(<StorageFormatSettings usage={null} />);
    await waitFor(() => expect(screen.getByTestId('storage-format-migration').textContent).toContain('Conversion stopped at 40 of 100'));
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Convert back' }));
    expect(within(dialog()).getByText('Convert to Maildir (.eml files)')).toBeTruthy();
    expect(radio('retire').checked).toBe(true);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Start conversion' }));
    await waitFor(() => expect(convert).toHaveBeenCalledWith('maildir', 'retire'));
  });

  it('a failed conversion says why, and offers the same way on', async () => {
    get.mockResolvedValue({ format: 'jmap', migration: job({ state: 'failed', active: false, done: 9, total: 10, error: 'No space left on device' }) });
    render(<StorageFormatSettings usage={null} />);
    await waitFor(() => expect(screen.getByTestId('storage-format-migration').textContent).toContain('Conversion stopped at 9 of 10'));
    expect(screen.getByText('Conversion stopped: No space left on device. Nothing was deleted for the messages that failed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Convert back' })).toBeTruthy();
  });

  it('a running conversion shows its progress with Pause and Cancel, and follows its events', async () => {
    get.mockResolvedValue({ format: 'jmap', migration: job() });
    render(<StorageFormatSettings usage={null} />);
    await waitFor(() => expect(screen.getByTestId('storage-format-migration').textContent).toContain('Converting messages: 5 of 10'));
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull();
    expect(screen.queryByText('Reclaim space')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(progress).toBeTypeOf('function'));
    act(() => progress(job({ state: 'paused', done: 7 })));
    expect(screen.getByTestId('storage-format-migration').textContent).toContain('Converting messages: 7 of 10');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it('shows a busy refusal in its catalog words', async () => {
    convert.mockRejectedValue(new Error('E_FORMAT_BUSY: j1'));
    render(<StorageFormatSettings usage={null} />);
    await waitFor(() => screen.getByRole('button', { name: 'Convert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Start conversion' }));
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toBe('A conversion is already running.'));
  });

  it('shows every other refusal in its catalog words, never the daemon text', async () => {
    convert.mockRejectedValue(new Error('E_FORMAT_SAME: the vault is in this format already'));
    render(<StorageFormatSettings usage={null} />);
    await waitFor(() => screen.getByRole('button', { name: 'Convert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Start conversion' }));
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toBe('The vault is already in this format.'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
  });

  it('shows a failed pause, reclaim and purge in their catalog words', async () => {
    get.mockResolvedValue({ format: 'jmap', migration: job() });
    pause.mockRejectedValue(new Error('E_FORMAT_NOT_FOUND: no conversion to steer'));
    const { unmount } = render(<StorageFormatSettings usage={null} />);
    await waitFor(() => screen.getByRole('button', { name: 'Pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('There is no conversion to pause, resume or cancel.'));
    unmount();

    get.mockResolvedValue(JMAP);
    reclaimSpace.mockRejectedValue(new Error('E_FORMAT_RECLAIM_FAILED: the sweep stopped'));
    render(<StorageFormatSettings usage={null} />);
    await waitFor(() => screen.getByRole('button', { name: 'Reclaim space' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reclaim space' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not reclaim space. Check that the vault folder is reachable and try again.'));
  });

  it('shows a failed purge in its catalog words', async () => {
    retired.mockResolvedValue({ bytes: 10, count: 1 });
    purgeRetired.mockRejectedValue(new Error('E_FORMAT_PURGE_FAILED: some files stayed'));
    render(<StorageFormatSettings usage={null} />);
    await waitFor(() => screen.getByRole('button', { name: 'Delete old files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete old files' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not delete all the old files. Check that the vault folder is reachable and try again.'));
  });

  it('names the space to free when the old files will not fit', async () => {
    convert.mockRejectedValue(new Error(`E_FORMAT_NO_SPACE: ${5 * GB}`));
    render(<StorageFormatSettings usage={null} />);
    await waitFor(() => screen.getByRole('button', { name: 'Convert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Start conversion' }));
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toBe(
      `Not enough free space to keep the old files aside. Free ${formatBytes(5 * GB)} or choose to delete them after verification.`,
    ));
  });

  it('offers Reclaim space in JMAP format', async () => {
    get.mockResolvedValue(JMAP);
    render(<StorageFormatSettings usage={null} />);
    await waitFor(() => expect(screen.getByTestId('storage-format-current').textContent).toBe('JMAP (JSON records + blobs)'));
    fireEvent.click(screen.getByRole('button', { name: 'Reclaim space' }));
    await waitFor(() => expect(reclaimSpace).toHaveBeenCalledTimes(1));
  });

  it('renders nothing when the daemon cannot say', async () => {
    get.mockRejectedValue(new Error('errors.daemonUnavailable'));
    const { container } = render(<StorageFormatSettings usage={null} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await act(async () => {});
    expect(container.innerHTML).toBe('');
  });
});
