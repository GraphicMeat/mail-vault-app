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
vi.mock('../email/AttachmentBar', () => ({ exportFolderName: (name, fallback) => `${name} - ${fallback}` }));
const exportAttachments = vi.fn(async () => ({ dir: '/Users/me/Downloads/x', files: 3, skipped: 0 }));
const exportRowAttachments = vi.fn(async () => ({ dir: '/Users/me/Downloads/x', files: 1, skipped: 0 }));
vi.mock('../../stores/viewStore', () => ({
  useViewStore: selector => selector({ exportAttachments, exportRowAttachments }),
  viewLabel: view => view.name,
}));

const { ViewAttachmentsDownload } = await import('../ViewAttachmentsDownload');

const view = def => ({ id: 'v1', name: 'Invoices', def: { hasAttachments: true, ...def } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 25, 12));
  exportAttachments.mockClear();
});
afterEach(() => {
  cleanup();
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
    expect(destDir).toBe('/Users/me/Downloads/Invoices August - email.attachments.folderName');
    await waitFor(() => expect(screen.getByTestId('view-download-attachments').textContent).toContain('views.download.done'));
  });

  it('"Everything" hands the view over unchanged', async () => {
    const saved = view({ withinDays: 30 });
    render(<ViewAttachmentsDownload view={saved} />);
    fireEvent.click(screen.getByTestId('view-download-attachments'));
    fireEvent.click(screen.getAllByRole('menuitem')[0]);
    await waitFor(() => expect(exportAttachments).toHaveBeenCalledWith(saved.def, '/Users/me/Downloads/Invoices - email.attachments.folderName'));
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
    await waitFor(() => expect(exportRowAttachments).toHaveBeenCalledWith(rows, '/Users/me/Downloads/Search results - email.attachments.folderName'));
    expect(exportAttachments).not.toHaveBeenCalled();
  });
});
