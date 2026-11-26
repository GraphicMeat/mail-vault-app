// @vitest-environment jsdom
// The folder drawer on the phone: with All Inboxes open, one collapsible section per shown
// account with its own folder tree (read when the section opens, the open ones remembered), and
// folder glyphs in desktop's colours everywhere the phone draws a folder: the drawer, the move
// picker. A held folder offers desktop's palette.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, within, act, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';
import { ALL_INBOXES } from '../folders.js';
import { FOLDER_ICON_PALETTE } from '../../utils/folderIconColor.js';

const engine = vi.hoisted(() => ({
  calls: [],
  folders: {
    a1: [
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 3, depth: 0 },
      { path: 'Sent', name: 'Sent', specialUse: '\\sent', unseen: 0, depth: 0 },
      { path: 'Projects', name: 'Projects', specialUse: null, unseen: 0, depth: 0 },
    ],
    a2: [
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 1, depth: 0 },
      { path: 'Bin', name: 'Bin', specialUse: '\\trash', unseen: 0, depth: 0 },
    ],
  },
}));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    if (method === 'mobile.folders.list') return { folders: (engine.folders[params.accountId] || []).map((f) => ({ ...f })) };
    if (method === 'mobile.prefs.set') return { ...params };
    return {};
  }),
  listen: vi.fn(() => () => {}),
}));

const { default: FolderDrawer } = await import('../FolderDrawer.jsx');
const { default: MovePicker } = await import('../MovePicker.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const a1 = { id: 'a1', email: 'ada@example.test', displayName: 'Ada' };
const a2 = { id: 'a2', email: 'bo@example.test', displayName: 'bo@example.test', needsAuth: true, oauth: true };

beforeEach(() => {
  engine.calls.length = 0;
  try { window.localStorage.clear(); } catch { /* none */ }
  useMobileStore.setState({ prefs: { ...PREF_DEFAULTS }, unread: { a1: 3, a2: 1 } });
});
afterEach(cleanup);

const colorOf = (el) => el.querySelector('.mv-folder__icon svg').style.color;
const rowOf = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

function unified(props = {}) {
  return render(
    <FolderDrawer
      account={a1}
      accounts={[a1, a2]}
      folders={[]}
      activeFolder={ALL_INBOXES}
      onSelect={() => {}}
      onSelectIn={() => {}}
      onClose={() => {}}
      onSwitchAccount={() => {}}
      {...props}
    />,
  );
}

describe('All Inboxes in the drawer', () => {
  it('lists All Inboxes, then one collapsed section per account, and reads no folders yet', () => {
    unified();
    const drawer = screen.getByRole('dialog', { name: t('mobile.drawer.title') });
    expect(within(drawer).getByRole('button', { name: t('sidebar.allInboxes') }).getAttribute('aria-current')).toBe('true');
    const heads = drawer.querySelectorAll('[data-mv-drawer-account]');
    expect([...heads].map((h) => h.dataset.mvDrawerAccount)).toEqual(['a1', 'a2']);
    for (const h of heads) expect(h.getAttribute('aria-expanded')).toBe('false');
    expect(within(drawer).queryByText('Projects')).toBeNull();
    expect(engine.calls.filter(([m]) => m === 'mobile.folders.list')).toEqual([]);
  });

  it('an account opens on tap, reading its folders once, in desktop\'s colours', async () => {
    unified();
    const head = document.querySelector('[data-mv-drawer-account="a1"]');
    await act(async () => { fireEvent.click(head); });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(screen.getByText('Projects')).toBeTruthy());
    expect(engine.calls.filter(([m]) => m === 'mobile.folders.list')).toEqual([['mobile.folders.list', { accountId: 'a1' }]]);
    expect(colorOf(rowOf(t('sidebar.inbox')))).toBe('rgb(59, 130, 246)');
    expect(colorOf(rowOf(t('mobile.folder.sent')))).toBe('rgb(14, 165, 233)');
    expect(colorOf(rowOf('Projects'))).toBe('rgb(20, 184, 166)');
    // Closing and opening again does not read again.
    await act(async () => { fireEvent.click(head); });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { fireEvent.click(head); });
    expect(engine.calls.filter(([m]) => m === 'mobile.folders.list').length).toBe(1);
  });

  it('a folder of an account opens that account\'s folder', async () => {
    const onSelectIn = vi.fn();
    unified({ onSelectIn });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-drawer-account="a2"]')); });
    await waitFor(() => expect(screen.getByText(t('mobile.folder.trash'))).toBeTruthy());
    fireEvent.click(rowOf(t('mobile.folder.trash')));
    expect(onSelectIn).toHaveBeenCalledWith('a2', 'Bin');
  });

  it('remembers which accounts were open', async () => {
    const first = unified();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-drawer-account="a2"]')); });
    first.unmount();
    unified();
    expect(document.querySelector('[data-mv-drawer-account="a2"]').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-mv-drawer-account="a1"]').getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.getByText(t('mobile.folder.trash'))).toBeTruthy());
  });

  it('an account with an issue wears the warning dot, with its unread count beside it', () => {
    unified();
    expect(document.querySelector('[data-mv-drawer-account="a2"] .mv-avatar__dot')).toBeTruthy();
    expect(document.querySelector('[data-mv-drawer-account="a1"] .mv-avatar__dot')).toBeNull();
    expect(document.querySelector('[data-mv-drawer-account="a1"]').textContent).toContain('3');
  });

  it('a section that cannot be read says so instead of staying empty', async () => {
    const { daemonCall } = await import('../transport.js');
    daemonCall.mockImplementationOnce(async () => { throw new Error('boom'); });
    unified({ accounts: [a1] });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-drawer-account="a1"]')); });
    await waitFor(() => expect(screen.getByText(t('mobile.drawer.empty'))).toBeTruthy());
  });
});

describe('a single account in the drawer', () => {
  it('keeps its structure: its folders at once, no account sections, same colours', () => {
    render(
      <FolderDrawer account={a1} accounts={[a1, a2]} folders={engine.folders.a1} activeFolder="INBOX" onSelect={() => {}} onSelectIn={() => {}} onClose={() => {}} onSwitchAccount={() => {}} />,
    );
    expect(document.querySelectorAll('[data-mv-drawer-account]').length).toBe(0);
    expect(colorOf(rowOf(t('sidebar.inbox')))).toBe('rgb(59, 130, 246)');
    expect(colorOf(rowOf('Projects'))).toBe('rgb(20, 184, 166)');
  });

  it('the head wears the warning dot when the account has an issue', () => {
    render(<FolderDrawer account={a2} accounts={[a1, a2]} folders={[]} activeFolder="INBOX" onSelect={() => {}} onClose={() => {}} onSwitchAccount={() => {}} />);
    expect(document.querySelector('.mv-drawer__head .mv-avatar__dot')).toBeTruthy();
  });

  it('the theme style gives every glyph the one accent', () => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, folderIconStyle: 'theme' } });
    render(<FolderDrawer account={a1} accounts={[a1]} folders={engine.folders.a1} activeFolder="INBOX" onSelect={() => {}} onClose={() => {}} onSwitchAccount={() => {}} />);
    expect(colorOf(rowOf(t('sidebar.inbox')))).toBe('var(--mail-accent-text)');
    expect(colorOf(rowOf('Projects'))).toBe('var(--mail-accent-text)');
  });
});

describe('colouring one folder', () => {
  const hold = (el) => fireEvent.contextMenu(el);

  it('a held folder offers desktop\'s palette, and a pick is saved for that account\'s folder', async () => {
    render(<FolderDrawer account={a1} accounts={[a1]} folders={engine.folders.a1} activeFolder="INBOX" onSelect={() => {}} onClose={() => {}} onSwitchAccount={() => {}} />);
    hold(rowOf('Projects'));
    const sheet = screen.getByRole('dialog', { name: t('sidebar.folderIconColor') });
    const swatches = within(sheet).getAllByRole('button').filter((b) => b.dataset.color);
    expect(swatches.map((b) => b.dataset.color)).toEqual(FOLDER_ICON_PALETTE);
    await act(async () => { fireEvent.click(swatches[7]); });
    expect(engine.calls.filter(([m]) => m === 'mobile.prefs.set').at(-1)[1]).toEqual({ folderIconColors: { 'a1|Projects': FOLDER_ICON_PALETTE[7] } });
    expect(screen.queryByRole('dialog', { name: t('sidebar.folderIconColor') })).toBeNull();
  });

  it('the default button takes the pick away, leaving the others', async () => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, folderIconColors: { 'a1|Projects': '#ec4899', 'a1|Sent': '#22c55e' } } });
    render(<FolderDrawer account={a1} accounts={[a1]} folders={engine.folders.a1} activeFolder="INBOX" onSelect={() => {}} onClose={() => {}} onSwitchAccount={() => {}} />);
    expect(colorOf(rowOf('Projects'))).toBe('rgb(236, 72, 153)');
    hold(rowOf('Projects'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('sidebar.folderIconColorDefault') })); });
    expect(engine.calls.filter(([m]) => m === 'mobile.prefs.set').at(-1)[1]).toEqual({ folderIconColors: { 'a1|Sent': '#22c55e' } });
  });

  it('a held folder in an account section is that account\'s', async () => {
    unified();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-drawer-account="a2"]')); });
    await waitFor(() => expect(screen.getByText(t('mobile.folder.trash'))).toBeTruthy());
    hold(rowOf(t('mobile.folder.trash')));
    const sheet = screen.getByRole('dialog', { name: t('sidebar.folderIconColor') });
    await act(async () => { fireEvent.click(within(sheet).getAllByRole('button').find((b) => b.dataset.color)); });
    expect(engine.calls.filter(([m]) => m === 'mobile.prefs.set').at(-1)[1]).toEqual({ folderIconColors: { 'a2|Bin': FOLDER_ICON_PALETTE[0] } });
  });

  it('holding a row still for a moment does the same as the context menu', () => {
    vi.useFakeTimers();
    try {
      render(<FolderDrawer account={a1} accounts={[a1]} folders={engine.folders.a1} activeFolder="INBOX" onSelect={() => {}} onClose={() => {}} onSwitchAccount={() => {}} />);
      const row = rowOf('Projects').closest('li');
      fireEvent.pointerDown(row, { pointerId: 1, clientX: 40, clientY: 40, button: 0, isPrimary: true });
      act(() => { vi.advanceTimersByTime(400); });
      expect(screen.getByRole('dialog', { name: t('sidebar.folderIconColor') })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the move picker', () => {
  it('draws each folder with its glyph in the same colours', () => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, folderIconColors: { 'a1|Projects': '#ec4899' } } });
    render(<MovePicker accountId="a1" folders={engine.folders.a1} current="INBOX" onPick={() => {}} onClose={() => {}} />);
    expect(colorOf(rowOf(t('mobile.folder.sent')))).toBe('rgb(14, 165, 233)');
    expect(colorOf(rowOf('Projects'))).toBe('rgb(236, 72, 153)');
    for (const svg of document.querySelectorAll('.mv-folder__icon svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});
