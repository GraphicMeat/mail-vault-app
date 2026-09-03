// @vitest-environment jsdom
//
// A file dropped on the compose window in the app arrives as a native Tauri
// drop: `tauri://drag-enter` / `tauri://drag-drop` with pasteboard paths and a
// pointer position, never as an HTML5 `drop` (see src/utils/nativeDrop.js).
// The modal asks Rust for the bytes and routes them by the element under the
// point: an image over the editor is placed inline, everything else attaches.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const { listeners, invoke, insertImages } = vi.hoisted(() => ({ listeners: {}, invoke: vi.fn(), insertImages: vi.fn() }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, cb) => { listeners[name] = cb; return () => { delete listeners[name]; }; }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, initial, animate, exit, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));
vi.mock('../RichTextEditor', () => ({
  RichTextEditor: ({ placeholder }) => React.createElement('div', { className: 'ProseMirror', 'data-testid': 'editor-stub' }, placeholder),
  insertImages: (...args) => insertImages(...args),
  textToHtml: (s) => s || '',
  htmlToText: (h) => (h || '').replace(/<[^>]*>/g, ''),
  inlineComposeSpacing: (h) => h,
}));
vi.mock('../ContactsPicker', () => ({ ContactsPickerButton: () => null, ContactsAutocomplete: () => null }));
vi.mock('../../services/localDrafts', () => ({
  resolveDraftsMailbox: vi.fn().mockResolvedValue('Drafts'),
  saveLocalDraft: vi.fn().mockResolvedValue(undefined),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  newDraftUid: () => 1,
}));
vi.mock('../../services/api', () => ({}));
vi.mock('../../services/db', () => ({}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: vi.fn() }));
vi.mock('../../utils/sendAsSuggestions', async (orig) => ({
  ...(await orig()),
  suggestSendAsAddresses: vi.fn().mockResolvedValue([]),
}));

const account = { id: 'acct-1', email: 'me@example.test', name: 'Me' };
const mail = { accounts: [account], activeAccountId: 'acct-1', lastSelectedAccountId: 'acct-1', activeMailbox: 'INBOX' };
const settings = {
  getSignature: () => '', getDisplayName: () => 'Me', getOrderedAccounts: (accounts) => accounts,
  sendAsAddresses: {}, sendDelay: 0, emailTemplates: [], spellcheckEnabled: true, addEmailTemplate: vi.fn(), lastComposeIdentity: null,
};
vi.mock('../../stores/mailStore', () => {
  const hook = vi.fn((selector) => selector(mail));
  hook.getState = () => mail;
  hook.setState = vi.fn();
  return { useMailStore: hook };
});
vi.mock('../../stores/accountStore', () => ({ useAccountStore: (selector) => selector(mail) }));
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  return { useSettingsStore: hook };
});

const { ComposeModal } = await import('../ComposeModal');

const SHOT = '/private/var/folders/T/TemporaryItems/NSIRD_screencaptureui_x/Screenshot 2026-09-03 at 12.04.41.png';
const NOTES = '/Users/me/notes.pdf';
const file = (path, content = 'AAAA') => ({ name: path.split('/').pop(), size: 3, content });

let under; // element document.elementFromPoint answers with
async function mount() {
  render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
  await waitFor(() => expect(listeners['tauri://drag-drop']).toBeTypeOf('function'));
}
const fire = (name, payload) => listeners[name]({ event: name, payload });

beforeEach(() => {
  window.__TAURI__ = {};
  document.elementFromPoint = (x, y) => under(x, y);
  invoke.mockReset();
  insertImages.mockReset();
});
afterEach(() => { cleanup(); delete window.__TAURI__; delete document.elementFromPoint; });

describe('native file drop on the compose window', () => {
  it('shows the attach strip while a file drag is over the window and attaches a file dropped on it', async () => {
    await mount();
    invoke.mockResolvedValueOnce([file(SHOT)]);

    fire('tauri://drag-enter', { paths: [SHOT], position: { x: 10, y: 10 } });
    const strip = await screen.findByTestId('compose-attach-dropzone');
    under = () => strip;

    fire('tauri://drag-drop', { paths: [SHOT], position: { x: 400, y: 600 } });

    await waitFor(() => expect(screen.getByTestId('compose-attachment').dataset.filename).toBe('Screenshot 2026-09-03 at 12.04.41.png'));
    expect(invoke).toHaveBeenCalledWith('read_dropped_files', { paths: [SHOT] });
    await waitFor(() => expect(screen.queryByTestId('compose-attach-dropzone')).toBeNull());
    expect(insertImages).not.toHaveBeenCalled();
  });

  it('places an image dropped on the editor inline and attaches the rest of the same drop', async () => {
    await mount();
    invoke.mockResolvedValueOnce([file(SHOT), file(NOTES, 'BBBB')]);
    under = () => screen.getByTestId('editor-stub');

    fire('tauri://drag-drop', { paths: [SHOT, NOTES], position: { x: 300, y: 300 } });

    await waitFor(() => expect(insertImages).toHaveBeenCalledTimes(1));
    const [, images] = insertImages.mock.calls[0];
    expect(images).toEqual([{ src: 'data:image/png;base64,AAAA', name: 'Screenshot 2026-09-03 at 12.04.41.png' }]);
    await waitFor(() => expect(screen.getByTestId('compose-attachment').dataset.filename).toBe('notes.pdf'));
  });

  it('hides the strip again and reads nothing when the drop lands outside the modal', async () => {
    await mount();
    fire('tauri://drag-enter', { paths: [SHOT], position: { x: 10, y: 10 } });
    await screen.findByTestId('compose-attach-dropzone');
    under = () => document.body;

    fire('tauri://drag-drop', { paths: [SHOT], position: { x: 1, y: 1 } });

    await waitFor(() => expect(screen.queryByTestId('compose-attach-dropzone')).toBeNull());
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows the read error instead of losing the drop silently', async () => {
    await mount();
    invoke.mockRejectedValueOnce('shot.png: Permission denied');
    under = () => screen.getByTestId('compose-modal');

    fire('tauri://drag-drop', { paths: [SHOT], position: { x: 300, y: 300 } });

    await screen.findByText('shot.png: Permission denied');
    expect(screen.queryByTestId('compose-attachment')).toBeNull();
  });
});
