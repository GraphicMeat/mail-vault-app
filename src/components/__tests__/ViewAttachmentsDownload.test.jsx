// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name)), has: () => true });
});
vi.mock('../../i18n/index.js', () => ({
  t: key => key,
  getLocale: () => 'en',
  useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));
vi.mock('@tauri-apps/api/path', () => ({
  downloadDir: async () => '/Users/me/Downloads',
  join: async (...parts) => parts.join('/'),
}));
vi.mock('../email/AttachmentBar', () => ({
  exportFolderName: (name, fallback) => `${name} - ${fallback}`,
  ExportProgress: ({ progress }) => <div role="progressbar" aria-valuenow={progress.done} aria-valuemax={progress.total} />,
  SavedToFolder: () => null,
}));
const exportAttachments = vi.fn(async () => ({ dir: '/Users/me/Downloads/x', files: 3, skipped: 0 }));
const exportRowAttachments = vi.fn(async () => ({ dir: '/Users/me/Downloads/x', files: 1, skipped: 0 }));
vi.mock('../../stores/viewStore', () => ({
  useViewStore: selector => selector({ exportAttachments, exportRowAttachments }),
  viewLabel: view => view.name,
}));

const { ViewAttachmentsDownload } = await import('../ViewAttachmentsDownload');
const { useAttachmentExports } = await import('../../services/attachmentExport');

// The folder picker, answered through the live bridge like the app's.
let picked = '/Users/me/Picked';
const invoke = vi.fn(async (cmd) => (cmd === 'plugin:dialog|open' ? picked : null));
const dialogCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === 'plugin:dialog|open');

const view = def => ({ id: 'v1', name: 'Invoices', def: { hasAttachments: true, ...def } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 25, 12));
  exportAttachments.mockClear();
  exportRowAttachments.mockClear();
  picked = '/Users/me/Picked';
  invoke.mockClear();
  window.__TAURI__ = { core: { invoke } };
  useAttachmentExports.setState({}, true);
});
afterEach(() => {
  cleanup();
  delete window.__TAURI__;
  vi.useRealTimers();
});

describe('downloading a view’s attachments', () => {
  it('a window across two months asks which part, on a wheel', async () => {
    render(<ViewAttachmentsDownload view={view({ withinDays: 30 })} />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    const wedges = screen.getAllByRole('menuitem');
    expect(wedges.map(wedge => wedge.getAttribute('aria-label'))).toEqual(['views.download.all', 'September', 'August']);
    expect(exportAttachments).not.toHaveBeenCalled();

    fireEvent.click(wedges[2]);
    await waitFor(() => expect(exportAttachments).toHaveBeenCalledTimes(1));
    const [def, destDir] = exportAttachments.mock.calls[0];
    expect(def).toMatchObject({ withinDays: null, range: null, dateTo: Math.floor(new Date(2026, 8, 1).getTime() / 1000) - 1 });
    expect(destDir).toBe('/Users/me/Picked/Invoices August - email.attachments.folderName');
    expect(exportAttachments.mock.calls[0][2]).toBe('/Users/me/Picked');
    await waitFor(() => expect(screen.getByTestId('view-download-attachments').textContent).toContain('views.download.done'));
  });

  it('"Everything" hands the view over unchanged', async () => {
    const saved = view({ withinDays: 30 });
    render(<ViewAttachmentsDownload view={saved} />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    fireEvent.click(screen.getAllByRole('menuitem')[0]);
    await waitFor(() => expect(exportAttachments).toHaveBeenCalledWith(saved.def, '/Users/me/Picked/Invoices - email.attachments.folderName', '/Users/me/Picked'));
  });

  it('a long range downloads everything straight away', async () => {
    render(<ViewAttachmentsDownload view={view({ range: 'lastYear' })} />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    expect(screen.queryByRole('menuitem')).toBeNull();
    await waitFor(() => expect(exportAttachments).toHaveBeenCalledTimes(1));
  });

  it('says so when nothing was found, and when the download failed', async () => {
    exportAttachments.mockResolvedValueOnce({ dir: '/x', files: 0, skipped: 0 });
    render(<ViewAttachmentsDownload view={view({})} />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    await waitFor(() => expect(screen.getByTestId('view-download-attachments').textContent).toContain('views.download.none'));
    cleanup();
    exportAttachments.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ViewAttachmentsDownload view={view({})} />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    await waitFor(() => expect(screen.getByTestId('view-download-attachments').textContent).toContain('email.attachments.failedDownload'));
  });

  it('a search downloads the rows it put on screen, with no wheel', async () => {
    const rows = [{ _accountId: 'a', _mailbox: 'INBOX', uid: 4 }];
    render(<ViewAttachmentsDownload rows={rows} name="Search results" />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    expect(screen.queryByRole('menuitem')).toBeNull();
    await waitFor(() => expect(exportRowAttachments).toHaveBeenCalledWith(rows, '/Users/me/Picked/Search results - email.attachments.folderName', '/Users/me/Picked'));
    expect(exportAttachments).not.toHaveBeenCalled();
  });

  it('rows the vault never stored are counted, not reported as "none found"', async () => {
    exportRowAttachments.mockResolvedValueOnce({ dir: '/x', files: 0, skipped: 2 });
    render(<ViewAttachmentsDownload rows={[{ _accountId: 'a', _mailbox: 'INBOX', uid: 4 }]} name="Search results" />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    await waitFor(() => expect(screen.getByTestId('view-download-attachments').textContent).toBe('views.download.skipped:{"count":2}'));
  });

  // Owner 09-28: the toolbar asks where to save, like Download All.
  it('asks for a folder, opening on Downloads, and saves into it', async () => {
    render(<ViewAttachmentsDownload view={view({ range: 'lastYear' })} />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    await waitFor(() => expect(exportAttachments).toHaveBeenCalledTimes(1));
    expect(dialogCalls()).toHaveLength(1);
    expect(dialogCalls()[0][1].options).toMatchObject({ directory: true, defaultPath: '/Users/me/Downloads' });
    expect(exportAttachments.mock.calls[0][1]).toBe('/Users/me/Picked/Invoices - email.attachments.folderName');
  });

  it('a cancelled folder picker saves nothing', async () => {
    picked = null;
    render(<ViewAttachmentsDownload view={view({ withinDays: 30 })} />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    fireEvent.click(screen.getAllByRole('menuitem')[1]);
    await waitFor(() => expect(dialogCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('view-download-attachments').disabled).toBe(false));
    expect(exportAttachments).not.toHaveBeenCalled();
  });

  it('shows the progress of a save in place of the button', () => {
    useAttachmentExports.setState({ 'view:v1': { done: 2, total: 5 } }, true);
    render(<ViewAttachmentsDownload view={view({})} />);
    expect(screen.queryByTestId('view-download-attachments')).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
  });

  it('arrow keys go round the wheel', () => {
    render(<ViewAttachmentsDownload view={view({ withinDays: 30 })} />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    const wedges = screen.getAllByRole('menuitem');
    wedges[0].focus();
    fireEvent.keyDown(wedges[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(wedges[1]);
    fireEvent.keyDown(wedges[1], { key: 'ArrowLeft' });
    fireEvent.keyDown(wedges[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(wedges[2]);
  });
});
