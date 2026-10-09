// @vitest-environment jsdom
//
// The compose window has exactly ONE scroll view. A long message used to show
// two scrollbars at once: the window's own (`.compose-scroll`, which holds the
// address rows, attachments and body) and the editor's, nested inside it. The
// attachment list added a third (`max-h-32 overflow-y-auto`).
//
// jsdom has no layout, so a "scroll view" is read from what makes one:
//   - a Tailwind class `overflow-(x|y)-auto|scroll`, `overflow-auto|scroll`
//   - a `.compose-*` rule of src/styles/index.css that sets overflow auto|scroll
// (the stylesheet's `.compose-*` rules are injected, the rest of it is not
// needed and would only slow jsdom's selector engine down).
//
// The one scroller has to hold the editor, and nothing between the two may clip
// (`overflow-hidden`) or squash (`min-h-0`) the body, or a long message would be
// cut off instead of scrolling.

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

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

// The REAL RichTextEditor renders here: its own scroll box is half of the bug.
vi.mock('../ContactsPicker', () => ({
  ContactsPickerButton: () => null,
  ContactsAutocomplete: () => null,
}));
vi.mock('../../services/localDrafts', () => ({
  resolveDraftsMailbox: vi.fn().mockResolvedValue('Drafts'),
  saveLocalDraft: vi.fn().mockResolvedValue(undefined),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  newDraftUid: () => 1,
}));
vi.mock('../../services/api', () => ({}));
vi.mock('../../services/db', () => ({}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: vi.fn() }));

const account = { id: 'acct-1', email: 'me@example.test', name: 'Me' };
const mail = {
  accounts: [account],
  activeAccountId: 'acct-1',
  lastSelectedAccountId: 'acct-1',
  activeMailbox: 'INBOX',
};
const settings = {
  getSignature: () => '',
  getDisplayName: () => 'Me',
  getOrderedAccounts: (accounts) => accounts,
  sendAsAddresses: {},
  sendDelay: 0,
  emailTemplates: [],
  spellcheckEnabled: true,
  addEmailTemplate: vi.fn(),
  lastComposeIdentity: null,
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
vi.mock('../email/ThreadView', () => ({ ThreadView: () => null }));

const { ComposeModal } = await import('../ComposeModal');

const SCROLL_CLASS = /(^|\s)overflow(-[xy])?-(auto|scroll)(\s|$)/;
const CLIP_CLASS = /(^|\s)(overflow-hidden|min-h-0)(\s|$)/;

beforeAll(() => {
  // Only the `.compose-*` rules: they are where the window's own scroller lives.
  const css = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
  const rules = css.split('\n').filter((line) => /^\.compose-[\w-]+\s*\{.*\}\s*$/.test(line));
  const style = document.createElement('style');
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
});

afterEach(cleanup);

const isScrollView = (el) => {
  if (SCROLL_CLASS.test(el.getAttribute('class') || '')) return true;
  const cs = getComputedStyle(el);
  return ['auto', 'scroll'].includes(cs.overflowY) || ['auto', 'scroll'].includes(cs.overflow);
};

/** Every scroll view inside the compose column (the context aside is its own pane). */
const scrollViews = () => {
  const main = screen.getByTestId('compose-main');
  return [main, ...main.querySelectorAll('*')].filter(isScrollView);
};

const pdf = () => new File([new Uint8Array(64)], 'offer.pdf', { type: 'application/pdf' });

/** Dispatch through the DOM, like a browser drop onto the attach strip. */
function nativeDrop(target, files) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files, types: ['Files'], items: [], dropEffect: 'copy', effectAllowed: 'all' },
  });
  target.dispatchEvent(event);
}

const open = () =>
  render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);

describe('compose window scroll views', () => {
  it('has exactly one scroll view', async () => {
    open();
    await screen.findByTestId('compose-body');
    expect(scrollViews().map((el) => el.className)).toHaveLength(1);
  });

  it('has exactly one scroll view with an attachment, whose list no longer scrolls on its own', async () => {
    open();
    fireEvent.dragEnter(screen.getByTestId('compose-modal'), { dataTransfer: { types: ['Files'], files: [] } });
    nativeDrop(await screen.findByTestId('compose-attach-dropzone'), [pdf()]);
    await waitFor(() => expect(screen.getByTestId('compose-attachment').dataset.filename).toBe('offer.pdf'));

    expect(screen.getByTestId('compose-attachments').className).not.toMatch(SCROLL_CLASS);
    expect(scrollViews()).toHaveLength(1);
  });

  it('the one scroll view holds the address rows, the attachments and the editor', async () => {
    open();
    fireEvent.dragEnter(screen.getByTestId('compose-modal'), { dataTransfer: { types: ['Files'], files: [] } });
    nativeDrop(await screen.findByTestId('compose-attach-dropzone'), [pdf()]);
    await waitFor(() => screen.getByTestId('compose-attachment'));

    const views = scrollViews();
    expect(views).toHaveLength(1);
    const [scroller] = views;
    expect(scroller.contains(screen.getByTestId('compose-attachments'))).toBe(true);
    expect(scroller.contains(screen.getByTestId('compose-body'))).toBe(true);
    expect(scroller.querySelector('.compose-addresses')).not.toBeNull();
  });

  it('the footer (Send) stays outside the scroll view, always reachable', async () => {
    open();
    await screen.findByTestId('compose-body');
    const [scroller] = scrollViews();
    expect(scroller.querySelector('.compose-footer')).toBeNull();
  });

  it('nothing between the scroller and the editor clips or squashes a long message', async () => {
    open();
    const body = await screen.findByTestId('compose-body');
    const [scroller] = scrollViews();

    const blockers = [];
    for (let el = body; el && el !== scroller; el = el.parentElement) {
      if (CLIP_CLASS.test(el.getAttribute('class') || '')) blockers.push(el.getAttribute('class'));
    }
    expect(blockers).toEqual([]);
  });
});
