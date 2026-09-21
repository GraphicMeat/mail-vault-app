// @vitest-environment jsdom
//
// The attachment row in the viewer. Three contracts:
//   - it reads bytes from the MESSAGE's mailbox, not the view's — in All
//     Inboxes the view says `UNIFIED`, which is not a Maildir folder, and the
//     2026-09-04 report ("Failed to download") was exactly that read;
//   - images and PDFs preview inside the app, everything else only downloads,
//     and the separate "open externally" button hands the file to the system
//     app on the FIRST click, caching it first when nothing is cached yet;
//   - an attachment the prefetch already cached opens on the first click.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

// The vault/attachment-cache commands now route through transport.js
// (Task 2.1); delegate to the same dispatcher so every existing
// invoke.mockImplementation(...) above still drives their responses.
vi.mock('../../services/transport', () => ({ send: (...args) => invoke(...args) }));

// The Download button writes into the user's Downloads folder — the sandbox
// entitlement covers it, so no save dialog and no second click.
const existing = new Set();
vi.mock('@tauri-apps/api/path', () => ({
  downloadDir: async () => '/Users/test/Downloads',
  join: async (...parts) => parts.join('/'),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async (p) => existing.has(p) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

// Dragging out is a native AppKit/Win32/GTK drag session behind a plugin
// command; jsdom can only prove the seam — the right path, a PNG drag image.
class FakeChannel {}
vi.mock('@tauri-apps/api/core', () => ({ Channel: FakeChannel }));
vi.mock('modern-screenshot', () => ({ domToPng: async () => 'data:image/png;base64,ROW' }));
const dragCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === 'plugin:drag|start_drag');

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));
// The view is All Inboxes: the active mailbox is the pseudo-folder.
vi.mock('../../stores/accountStore', () => ({
  useAccountStore: (selector) => selector({ activeAccountId: 'acct-active', activeMailbox: 'UNIFIED' }),
}));

const { AttachmentItem, DownloadAllButton, attachmentIcon, exportFolderName } = await import('../email/AttachmentBar');

const PNG_B64 = 'iVBORw0KGgo=';
const PDF = { filename: 'invoice.pdf', contentType: 'application/pdf', size: 1200 };
const PNG = { filename: 'photo.png', contentType: 'image/png', size: 900 };
const ZIP = { filename: 'bundle.zip', contentType: 'application/zip', size: 5000 };

function renderItem(attachment, props = {}) {
  return render(
    <AttachmentItem
      attachment={attachment}
      attachmentIndex={0}
      emailUid={7}
      accountId="acct-1"
      mailbox="INBOX"
      {...props}
    />,
  );
}

beforeEach(() => {
  window.__TAURI__ = { core: { invoke } };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'cached_attachment_path') return null;
    if (cmd === 'maildir_read_attachment') return PNG_B64;
    if (cmd === 'cache_attachment') return '/cache/acct-1_INBOX_7_0_invoice.pdf';
    if (cmd === 'save_attachment_to') return args?.destPath;
    if (cmd === 'open_file') return null;
    if (cmd === 'plugin:drag|start_drag') return null;
    throw new Error(`unexpected command ${cmd}`);
  });
  existing.clear();
  URL.createObjectURL = vi.fn(() => 'blob:mock-pdf');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  delete window.__TAURI__;
});

describe('AttachmentItem download', () => {
  it("reads the bytes from the message's own mailbox, not the active view", async () => {
    renderItem(PDF);
    fireEvent.click(screen.getByTestId('attachment-download'));

    await waitFor(() => expect(screen.getByText('Downloaded')).toBeTruthy());
    const call = invoke.mock.calls.find(([cmd]) => cmd === 'maildir_read_attachment');
    expect(call[1]).toEqual({ accountId: 'acct-1', mailbox: 'INBOX', uid: 7, attachmentIndex: 0 });
    expect(invoke.mock.calls.some(([, args]) => args?.mailbox === 'UNIFIED')).toBe(false);
  });

  // The reported defect: Download put the file in the app's own cache, so
  // getting it into Downloads still needed a right-click and a save dialog.
  it('writes the file straight into the Downloads folder', async () => {
    renderItem(PDF);
    fireEvent.click(screen.getByTestId('attachment-download'));

    await waitFor(() => expect(screen.getByText('Downloaded')).toBeTruthy());
    const save = invoke.mock.calls.find(([cmd]) => cmd === 'save_attachment_to');
    expect(save[1].destPath).toBe('/Users/test/Downloads/invoice.pdf');
    expect(save[1].filename).toBe('invoice.pdf');
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'cache_attachment')).toBe(false);
  });

  // Overwriting a file already in Downloads would destroy an unrelated one
  // with the same name, which no browser download does either.
  it('does not overwrite a file of the same name already in Downloads', async () => {
    existing.add('/Users/test/Downloads/invoice.pdf');
    existing.add('/Users/test/Downloads/invoice (1).pdf');
    renderItem(PDF);
    fireEvent.click(screen.getByTestId('attachment-download'));

    await waitFor(() => expect(screen.getByText('Downloaded')).toBeTruthy());
    const save = invoke.mock.calls.find(([cmd]) => cmd === 'save_attachment_to');
    expect(save[1].destPath).toBe('/Users/test/Downloads/invoice (2).pdf');
  });

  it('shows an attachment the prefetch already cached as ready to open', async () => {
    invoke.mockImplementation(async (cmd) =>
      cmd === 'cached_attachment_path' ? '/cache/acct-1_INBOX_7_0_invoice.pdf' : null);
    renderItem(PDF);

    await waitFor(() => expect(screen.getByText('Click to open')).toBeTruthy());
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'cache_attachment')).toBe(false);
  });
});

describe('AttachmentItem preview', () => {
  it('previews an image inside the app', async () => {
    renderItem(PNG);
    fireEvent.click(screen.getByTestId('attachment-preview'));

    const img = await screen.findByTestId('attachment-preview-image');
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG_B64}`);
    const read = invoke.mock.calls.find(([cmd]) => cmd === 'maildir_read_attachment');
    expect(read[1]).toEqual({ accountId: 'acct-1', mailbox: 'INBOX', uid: 7, attachmentIndex: 0 });
  });

  it('previews a PDF in a frame', async () => {
    renderItem(PDF);
    fireEvent.click(screen.getByTestId('attachment-preview'));

    const frame = await screen.findByTestId('attachment-preview-pdf');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('blob:mock-pdf');
  });

  it('offers no preview for a type it cannot render', () => {
    renderItem(ZIP);
    expect(screen.queryByTestId('attachment-preview')).toBeNull();
    expect(screen.getByTestId('attachment-download')).toBeTruthy();
  });

  it('downloads from inside the preview', async () => {
    renderItem(PNG);
    fireEvent.click(screen.getByTestId('attachment-preview'));
    await screen.findByTestId('attachment-preview-image');

    fireEvent.click(screen.getByTestId('attachment-preview-download'));
    await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === 'save_attachment_to')).toBe(true));
  });
});

describe('AttachmentItem open externally', () => {
  const CACHED = '/cache/acct-1_INBOX_7_0_invoice.pdf';

  it('caches an uncached file and hands it to the system app, without the in-app dialog', async () => {
    renderItem(PDF);
    fireEvent.click(screen.getByTestId('attachment-open-external'));

    await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === 'open_file')).toBe(true));
    const cached = invoke.mock.calls.filter(([cmd]) => cmd === 'cache_attachment');
    expect(cached).toHaveLength(1);
    expect(cached[0][1]).toEqual({ accountId: 'acct-1', mailbox: 'INBOX', uid: 7, attachmentIndex: 0 });
    expect(invoke.mock.calls.find(([cmd]) => cmd === 'open_file')[1]).toEqual({ path: CACHED });
    expect(screen.queryByTestId('attachment-preview-dialog')).toBeNull();
  });

  it('opens an already-cached file without caching it again', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'cached_attachment_path' ? CACHED : null));
    renderItem(PDF);
    await waitFor(() => expect(screen.getByText('Click to open')).toBeTruthy());

    fireEvent.click(screen.getByTestId('attachment-open-external'));
    await waitFor(() => expect(invoke.mock.calls.filter(([cmd]) => cmd === 'open_file')).toHaveLength(1));
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'cache_attachment')).toBe(false);
  });

  it('leaves the eye button opening the in-app preview', async () => {
    renderItem(PDF);
    fireEvent.click(screen.getByTestId('attachment-preview'));

    await screen.findByTestId('attachment-preview-pdf');
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'open_file')).toBe(false);
  });

  it('reports a failed cache and opens nothing', async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'cached_attachment_path') return null;
      throw new Error('no such message');
    });
    renderItem(PDF);
    fireEvent.click(screen.getByTestId('attachment-open-external'));

    await waitFor(() => expect(screen.getByText('Failed to download')).toBeTruthy());
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'open_file')).toBe(false);
  });
});

describe('AttachmentItem tile', () => {
  it('shows the image itself instead of a generic file icon', async () => {
    renderItem(PNG);
    const thumb = await screen.findByTestId('attachment-thumb');
    expect(thumb.getAttribute('src')).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  // A 40px square is not worth pulling a camera original over IPC.
  it('leaves a huge image on its icon rather than reading it for a thumbnail', async () => {
    renderItem({ ...PNG, size: 20 * 1024 * 1024 });
    await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === 'cached_attachment_path')).toBe(true));
    expect(screen.queryByTestId('attachment-thumb')).toBeNull();
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'maildir_read_attachment')).toBe(false);
  });

  it('gives each kind its own icon', () => {
    const name = (att) => attachmentIcon(att)({})?.props?.['data-icon'];
    expect(name(ZIP)).toBe('FileArchive');
    expect(name({ filename: 'q3.xlsx' })).toBe('FileSpreadsheet');
    expect(name({ filename: 'clip.mov', contentType: 'video/quicktime' })).toBe('FileVideo');
    expect(name(PDF)).toBe('FileText');
    expect(name(ZIP)).not.toBe(name(PDF));
  });
});

describe('AttachmentItem save as', () => {
  it('offers Save As without a right-click', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    save.mockResolvedValue('/Users/test/Desktop/invoice.pdf');
    renderItem(PDF);

    fireEvent.click(screen.getByTestId('attachment-save-as'));

    await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === 'save_attachment_to')).toBe(true));
    const call = invoke.mock.calls.find(([cmd]) => cmd === 'save_attachment_to');
    expect(call[1].destPath).toBe('/Users/test/Desktop/invoice.pdf');
  });

  // A fourth icon button crushes the filename in the compact row.
  it('keeps the compact row to its three buttons', () => {
    renderItem(PDF, { compact: true });
    expect(screen.queryByTestId('attachment-save-as')).toBeNull();
  });
});

describe('AttachmentItem drag out', () => {
  it('cancels the browser drag and starts a native one on the cached file', async () => {
    renderItem(PDF);
    const row = screen.getByTestId('attachment-item');
    expect(row.getAttribute('draggable')).toBe('true');

    // fireEvent returns false when the handler called preventDefault — which
    // it must: WebKit's own drag hands the Desktop a .webloc, not the file.
    const notPrevented = fireEvent.dragStart(row, { dataTransfer: {} });
    expect(notPrevented).toBe(false);
    await waitFor(() => expect(dragCalls()).toHaveLength(1));

    const args = dragCalls()[0][1];
    expect(args.item).toEqual(['/cache/acct-1_INBOX_7_0_invoice.pdf']);
    expect(args.image.startsWith('data:image/png;base64,')).toBe(true);
    expect(args.onEvent).toBeInstanceOf(FakeChannel);
  });

  it('drags the file that is already cached without caching it twice', async () => {
    invoke.mockImplementation(async (cmd) =>
      (cmd === 'cached_attachment_path' ? '/cache/ready.pdf' : null));
    renderItem(PDF);
    await waitFor(() => expect(screen.getByText('Click to open')).toBeTruthy());

    fireEvent.dragStart(screen.getByTestId('attachment-item'), { dataTransfer: {} });

    await waitFor(() => expect(dragCalls()).toHaveLength(1));
    expect(dragCalls()[0][1].item).toEqual(['/cache/ready.pdf']);
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'cache_attachment')).toBe(false);
  });
});

describe('DownloadAllButton', () => {
  const ATTACHMENTS = [{ ...PDF, _originalIndex: 0 }, { ...ZIP, _originalIndex: 3 }];

  const renderAll = (props = {}) => render(
    <DownloadAllButton
      attachments={ATTACHMENTS}
      emailUid={7}
      accountId="acct-1"
      mailbox="INBOX"
      subject="Q3 report"
      {...props}
    />,
  );

  // The old loop called cache_attachment, which writes into the app's PRIVATE
  // cache: "Download All" put the files where the user could not find them.
  it('exports into a folder under Downloads and reveals it', async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'export_attachments') return { dir: '/Users/test/Downloads/Q3 report - Attachments', files: ['invoice.pdf', 'bundle.zip'] };
      return null;
    });
    renderAll();
    fireEvent.click(screen.getByTestId('attachment-download-all'));

    await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === 'export_attachments')).toBe(true));
    const call = invoke.mock.calls.find(([cmd]) => cmd === 'export_attachments');
    expect(call[1]).toEqual({
      accountId: 'acct-1',
      mailbox: 'INBOX',
      uid: 7,
      indices: [0, 3],
      destDir: '/Users/test/Downloads/Q3 report - Attachments',
    });
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'cache_attachment')).toBe(false);
    await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === 'show_in_folder')).toBe(true));
  });

  it('says so when the export fails instead of claiming a download', async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'export_attachments') throw new Error('disk full');
      return null;
    });
    renderAll();
    fireEvent.click(screen.getByTestId('attachment-download-all'));

    await waitFor(() => expect(screen.getByText('Failed to download')).toBeTruthy());
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'show_in_folder')).toBe(false);
  });

  // A subject is not a path component.
  it('keeps a hostile subject inside one folder name', () => {
    expect(exportFolderName('../../etc/passwd', 'Attachments')).toBe('etc-passwd - Attachments');
    expect(exportFolderName('   ', 'Attachments')).toBe('Attachments');
    expect(exportFolderName('a'.repeat(200), 'Attachments').length).toBeLessThan(80);
    expect(exportFolderName('Re: budget\nQ3', 'Attachments')).toBe('Re- budget Q3 - Attachments');
  });
});
