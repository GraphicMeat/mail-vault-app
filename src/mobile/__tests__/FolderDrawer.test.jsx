// @vitest-environment jsdom
// The folder drawer's head is the account in front, drawn as the list header's account button,
// and opens the account switcher; in All Inboxes it shows All Inboxes' glyph and name. Each folder
// row wears desktop's mailbox glyph (src/utils/mailboxIcon.js, shared with desktop's FolderTree),
// and Drafts, Follow up and Settings wear the glyphs desktop's sidebar gives them.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { t } from '../i18n.js';
import { ALL_INBOXES } from '../folders.js';

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async () => ({})),
  listen: vi.fn(() => () => {}),
}));

const { default: FolderDrawer } = await import('../FolderDrawer.jsx');
const { getMailboxIcon } = await import('../../utils/mailboxIcon.js');
const FolderTree = await import('../../components/FolderTree.jsx');

afterEach(cleanup);

const folder = (path, specialUse = null, extra = {}) => ({ path, name: path, specialUse, unseen: 0, total: 0, depth: 0, noselect: false, ...extra });
const account = { id: 'a1', email: 'ada@example.test', displayName: 'Ada Lovelace' };
const glyphOf = (el) => [...el.querySelector('svg').classList].find((c) => c.startsWith('lucide-'));

function draw(props = {}) {
  return render(
    <FolderDrawer
      account={account}
      folders={[folder('INBOX', '\\Inbox'), folder('Sent', '\\Sent'), folder('Bin', '\\trash'), folder('Projects')]}
      activeFolder="INBOX"
      onSelect={() => {}}
      onClose={() => {}}
      onDrafts={() => {}}
      followUps={1}
      onFollowUps={() => {}}
      onSettings={() => {}}
      onSwitchAccount={() => {}}
      {...props}
    />,
  );
}

describe('the drawer head', () => {
  it('is the account in front, and opens the account switcher', () => {
    const onSwitchAccount = vi.fn();
    draw({ onSwitchAccount });
    const drawer = screen.getByRole('dialog', { name: t('mobile.drawer.title') });
    const head = within(drawer).getByRole('button', { name: t('mobile.switcher.open', { email: 'ada@example.test' }) });
    expect(head.closest('.mv-drawer__head')).toBeTruthy();
    expect(head.textContent).toContain('Ada Lovelace');
    expect(head.querySelector('.mv-avatar')).toBeTruthy();
    expect(head.querySelector('.mv-header__chevron')).toBeTruthy();
    fireEvent.click(head);
    expect(onSwitchAccount).toHaveBeenCalledTimes(1);
  });

  it('shows the address when the account has no other name', () => {
    draw({ account: { id: 'a1', email: 'ada@example.test', displayName: 'ada@example.test' } });
    const head = screen.getByRole('button', { name: t('mobile.switcher.open', { email: 'ada@example.test' }) });
    expect(head.textContent).toContain('ada@example.test');
  });

  it('in All Inboxes shows its glyph and name, and still opens the switcher', () => {
    const onSwitchAccount = vi.fn();
    draw({ activeFolder: ALL_INBOXES, onSwitchAccount });
    const head = screen.getByRole('button', { name: t('mobile.switcher.open', { email: t('sidebar.allInboxes') }) });
    expect(head.textContent).toContain(t('sidebar.allInboxes'));
    expect(head.textContent).not.toContain('ada@example.test');
    expect(head.querySelector('.mv-avatar--all svg')).toBeTruthy();
    fireEvent.click(head);
    expect(onSwitchAccount).toHaveBeenCalledTimes(1);
  });
});

describe('the drawer rows wear desktop glyphs', () => {
  it('a folder wears its mailbox glyph: Sent the Send glyph, a plain folder the Folder glyph', () => {
    draw();
    const row = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
    expect(glyphOf(row(t('sidebar.inbox')))).toBe('lucide-inbox');
    expect(glyphOf(row(t('mobile.folder.sent')))).toBe('lucide-send');
    // The engine passes the server's spelling of the special use; any case is the same folder.
    expect(glyphOf(row(t('mobile.folder.trash')))).toBe('lucide-trash2');
    expect(glyphOf(row('Projects'))).toBe('lucide-folder');
    for (const svg of document.querySelectorAll('.mv-folder__icon svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('Drafts, Follow up and Settings wear the glyphs desktop gives them', () => {
    draw();
    expect(glyphOf(document.querySelector('[data-mv-drafts]'))).toBe('lucide-file');
    expect(glyphOf(document.querySelector('[data-mv-followups-open]'))).toBe('lucide-bell');
    expect(glyphOf(document.querySelector('[data-mv-settings]'))).toBe('lucide-settings');
  });
});

describe('mailboxIcon.js', () => {
  it('is the one desktop FolderTree uses, re-exported from there', () => {
    expect(FolderTree.getMailboxIcon).toBe(getMailboxIcon);
    expect(getMailboxIcon({ path: 'Sent', specialUse: '\\Sent' }).displayName).toBe('Send');
    expect(getMailboxIcon({ path: 'INBOX' }).displayName).toBe('Inbox');
    expect(getMailboxIcon({ path: 'X', local: true }).displayName).toBe('HardDrive');
    expect(getMailboxIcon({ path: 'X' }).displayName).toBe('Folder');
  });
});
