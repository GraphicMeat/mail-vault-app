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

const { AttachmentItem } = await import('../email/AttachmentBar');

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
