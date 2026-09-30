import { describe, expect, it } from 'vitest';
import { QUICK_ACTION_SURFACE_ACTIONS, QUICK_ACTION_TYPES } from '../quickActions';
import { QUICK_ACTION_RULES, quickActionAvailability } from '../quickActionAvailability';

// A single resolved, server-backed, unread message in acct-a with every
// handler wired: nothing is held back.
const facts = (overrides = {}) => ({
  present: true, count: 1, primary: null,
  has: { markRead: true, markUnread: false, star: true, unstar: false, archive: true, unarchive: false },
  resolved: true, fullyResolved: true, accountId: 'acct-a', mailbox: 'INBOX', locations: [],
  localFolder: false, localOnly: false, readOnly: false, serverBacked: true, serverActions: true,
  junkPath: 'Junk', snooze: true, unsubscribe: { email: {} }, purge: { label: 'Delete' }, sender: 's@x.test',
  senderName: 'S', sent: false, singleRecipient: false, dark: false,
  explicit: { star: false, archive: false },
  can: Object.fromEntries(QUICK_ACTION_TYPES.map(action => [action, true])),
  busy: {},
  ...overrides,
});
const FOLDERS = { 'acct-a': [{ path: 'Archive' }, { path: 'Parent', noselect: true }] };
const ctx = { tags: [{ id: 'tag-1' }], templates: [{ id: 'tpl-1' }], folders: accountId => FOLDERS[accountId] || [] };
const check = (surface, entry, overrides) => quickActionAvailability(surface, { id: entry.action, ...entry }, facts(overrides), ctx);

describe('quickActionAvailability', () => {
  it('has a rule, over defined gates, for every action on every surface', () => {
    for (const action of QUICK_ACTION_TYPES) {
      expect(QUICK_ACTION_RULES[action], action).toBeTruthy();
      for (const surface of ['row', 'selection', 'reader']) {
        expect(() => check(surface, { action })).not.toThrow();
      }
    }
  });

  it('never hides on the selection bar; the row hides and the bar disables the side that does not apply', () => {
    expect(check('selection', { action: 'markUnread' })).toEqual({ hidden: undefined, disabled: true });
    expect(check('row', { action: 'markUnread' })).toEqual({ hidden: true, disabled: false });
    // A thread row's split toggle offers both sides.
    expect(check('row', { action: 'markUnread', thread: true })).toEqual({ hidden: false, disabled: false });
  });

  // A saved selection list may name any action (normalization keeps them);
  // one the bar has no handler for must not read as a live button.
  it('disables on the selection bar every action it cannot run, whatever the target', () => {
    const unsupported = QUICK_ACTION_TYPES.filter(action => !QUICK_ACTION_SURFACE_ACTIONS.selection.includes(action));
    expect(unsupported).toContain('unsubscribe');
    for (const action of unsupported) expect(check('selection', { action }).disabled, action).toBe(true);
  });

  // A key no loaded list resolves has no flags to read, as for mark read.
  it('the selection bar needs every key resolved to star or unstar, as to mark read', () => {
    const has = { ...facts().has, unstar: true, markUnread: true };
    for (const action of ['star', 'unstar', 'markRead', 'markUnread']) {
      expect(check('selection', { action }, { has }).disabled, action).toBe(false);
      expect(check('selection', { action }, { has, fullyResolved: false }).disabled, action).toBe(true);
    }
  });

  it('the reader hides a star side only when both sides are configured', () => {
    expect(check('reader', { action: 'unstar' }).hidden).toBe(false);
    expect(check('reader', { action: 'unstar' }, { explicit: { star: true, archive: false } }).hidden).toBe(true);
  });

  it('the reader hides an action whose host handler is missing, and everything without a message', () => {
    const can = { ...facts().can, export: false };
    expect(check('reader', { action: 'export' }, { can }).hidden).toBe(true);
    expect(check('reader', { action: 'reply' }, { present: false }).hidden).toBe(true);
  });

  it('a saved move needs the target account and a folder it has', () => {
    expect(check('row', { action: 'move', params: { mailbox: 'Archive' } }).disabled).toBe(false);
    expect(check('row', { action: 'move', params: { mailbox: 'Nowhere' } }).disabled).toBe(true);
    expect(check('row', { action: 'move', params: { mailbox: 'Archive', accountId: 'acct-b' } }).disabled).toBe(true);
    expect(check('row', { action: 'move', params: { mailbox: 'Archive' } }, { accountId: null }).disabled).toBe(true);
    // A \Noselect folder only parents others, on every surface.
    for (const surface of ['row', 'selection', 'reader']) {
      expect(check(surface, { action: 'move', params: { mailbox: 'Parent' } }).disabled, surface).toBe(true);
    }
  });

  it('holds back the busy group only', () => {
    expect(check('reader', { action: 'delete' }, { busy: { delete: true } }).disabled).toBe(true);
    expect(check('reader', { action: 'archive' }, { busy: { delete: true } }).disabled).toBe(false);
  });
});
