// @vitest-environment jsdom
//
// The attachment row in the viewer. Three contracts:
//   - it reads bytes from the MESSAGE's mailbox, not the view's — in All
//     Inboxes the view says `UNIFIED`, which is not a Maildir folder, and the
//     2026-09-04 report ("Failed to download") was exactly that read;
//   - images and PDFs preview inside the app, everything else only downloads;
//   - an attachment the prefetch already cached opens on the first click.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

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
  invoke.mockImplementation(async (cmd) => {
    if (cmd === 'cached_attachment_path') return null;
    if (cmd === 'maildir_read_attachment') return PNG_B64;
    if (cmd === 'cache_attachment') return '/cache/acct-1_INBOX_7_0_invoice.pdf';
    throw new Error(`unexpected command ${cmd}`);
  });
  URL.createObjectURL = vi.fn(() => 'blob:mock-pdf');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  delete window.__TAURI__;
});

describe('AttachmentItem download', () => {
  it("caches the bytes from the message's own mailbox, not the active view", async () => {
    renderItem(PDF);
    fireEvent.click(screen.getByTestId('attachment-download'));

    await waitFor(() => expect(screen.getByText('Downloaded')).toBeTruthy());
    const call = invoke.mock.calls.find(([cmd]) => cmd === 'cache_attachment');
    expect(call[1]).toEqual({ accountId: 'acct-1', mailbox: 'INBOX', uid: 7, attachmentIndex: 0 });
    expect(invoke.mock.calls.some(([, args]) => args?.mailbox === 'UNIFIED')).toBe(false);
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
    await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === 'cache_attachment')).toBe(true));
  });
});
