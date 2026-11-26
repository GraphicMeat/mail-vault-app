// @vitest-environment node
// What the wheel and the bulk bar offer on the phone: an explicit decision for every action desktop
// has (run here, or shown disabled "on desktop", or hidden exactly as desktop hides it), the
// descriptors desktop's availability rules and the phone's own words give, and what each one runs.
import { describe, it, expect, vi } from 'vitest';
import { QUICK_ACTION_TYPES, QUICK_ACTION_SURFACE_ACTIONS } from '../../utils/quickActions.js';
import { t } from '../i18n.js';
import { DECISIONS, decisionOf } from '../quickActions/actionTable.js';
import { buildDescriptors, describeAction, phoneFacts } from '../quickActions/descriptors.js';

const row = (extra = {}) => ({ uid: 5, seen: false, flagged: false, fromName: 'Ada', fromAddress: 'ada@example.test', accountId: 'a1', folder: 'INBOX', ...extra });
const ctx = (extra = {}) => ({ tags: [{ id: 't1', name: 'Work' }], folders: () => [{ path: 'Archive', name: 'Archive' }, { path: 'Trash', name: 'Trash', noselect: true }], ...extra });
const entry = (action, params) => ({ id: action, action, ...(params ? { params } : {}) });
const facts = (rows = [row()], extra = {}) => phoneFacts(rows, { accountId: 'a1', mailbox: 'INBOX', junkPath: 'Junk', ...extra });
const describe1 = (surface, e, f = facts(), c = ctx()) => describeAction({ surface, entry: e, facts: f, ctx: c });

describe('the decision table', () => {
  it('decides every action desktop has, once, with a reason', () => {
    expect(Object.keys(DECISIONS).sort()).toEqual([...QUICK_ACTION_TYPES].sort());
    for (const [action, d] of Object.entries(DECISIONS)) {
      expect(['run', 'desktop', 'hidden', 'reader'], action).toContain(d.decision);
      if (d.decision !== 'run') expect(d.why.length, action).toBeGreaterThan(10);
    }
  });

  it('runs everything it says it runs, and nothing the reader alone has', () => {
    const run = Object.entries(DECISIONS).filter(([, d]) => d.decision === 'run').map(([a]) => a);
    expect(run.sort()).toEqual(['delete', 'deleteServer', 'forward', 'markRead', 'markUnread', 'move', 'reply', 'replyAll', 'spam', 'star', 'tag', 'toggleRead', 'unstar']);
    for (const action of ['source', 'theme']) {
      expect(decisionOf(action)).toBe('reader');
      expect(QUICK_ACTION_SURFACE_ACTIONS.row).not.toContain(action);
    }
  });
});

describe('descriptors', () => {
  it('say what desktop says: read toggles to the direction it takes, star pairs show their side', () => {
    expect(describe1('row', entry('toggleRead')).label).toBe(t('rowMenu.markRead'));
    const read = facts([row({ seen: true })]);
    expect(describe1('row', entry('toggleRead'), read).label).toBe(t('rowMenu.markUnread'));
    expect(describe1('row', entry('star')).hidden).toBe(false);
    expect(describe1('row', entry('unstar')).hidden).toBe(true);
    const starred = facts([row({ flagged: true })]);
    expect(describe1('row', entry('star'), starred).hidden).toBe(true);
    expect(describe1('row', entry('unstar'), starred).hidden).toBe(false);
  });

  it('show an action only desktop does as disabled, with where it is', () => {
    for (const action of ['archive', 'unarchive', 'deleteEverywhere', 'export', 'snooze', 'newMessage', 'open', 'replyTemplate']) {
      const d = describe1('row', entry(action, action === 'replyTemplate' ? { templateId: 'x' } : undefined));
      expect(d.disabled, action).toBe(true);
      expect(d.hidden, action).toBe(false);
      expect(d.label, action).toMatch(/desktop/);
    }
  });

  it('hide what desktop hides where there is nothing to show', () => {
    expect(describe1('row', entry('unsubscribe')).hidden).toBe(true);
    expect(describe1('row', entry('goToMailbox')).hidden).toBe(true);
  });

  it('name Delete as Delete, for either delete', () => {
    expect(describe1('row', entry('delete')).label).toBe(t('common.delete'));
    expect(describe1('row', entry('deleteServer')).label).toBe(t('common.delete'));
    expect(describe1('row', entry('deleteServer')).isDestructive).toBe(true);
    expect(describe1('row', entry('deleteServer')).disabled).toBe(false);
  });

  it('gate Move to a folder, Move to Junk and a label on what exists', () => {
    expect(describe1('row', entry('move')).disabled).toBe(false);
    expect(describe1('row', entry('move', { mailbox: 'Archive' })).disabled).toBe(false);
    expect(describe1('row', entry('move', { mailbox: 'Archive' })).label).toContain('Archive');
    expect(describe1('row', entry('move', { mailbox: 'Gone' })).disabled).toBe(true);
    expect(describe1('row', entry('move', { mailbox: 'Trash' })).disabled).toBe(true);
    // A saved move names a desktop account: it is the phone's own account here.
    expect(describe1('row', entry('move', { mailbox: 'Archive', accountId: 'desktop-id' })).disabled).toBe(false);
    expect(describe1('row', entry('spam')).disabled).toBe(false);
    expect(describe1('row', entry('spam'), facts([row()], { junkPath: null })).disabled).toBe(true);
    expect(describe1('row', entry('tag', { tagId: 't1' })).label).toBe('Work');
    expect(describe1('row', entry('tag', { tagId: 'nope' })).disabled).toBe(true);
  });

  it('are the selection bar\'s too: nothing hidden, what a bar cannot do disabled', () => {
    const f = facts([row(), row({ uid: 6, seen: true, flagged: true })]);
    for (const action of ['markRead', 'markUnread', 'star', 'unstar']) expect(describe1('selection', entry(action), f).disabled, action).toBe(false);
    expect(describe1('selection', entry('markRead'), facts([row({ seen: true }), row({ seen: true })])).disabled).toBe(true);
    expect(describe1('selection', entry('reply'), f).disabled).toBe(true);
    expect(describe1('selection', entry('archive'), f).disabled).toBe(true);
    expect(describe1('selection', entry('unstar'), f).hidden).toBeUndefined();
  });
});

describe('what a descriptor runs', () => {
  const handlers = () => ({
    setRead: vi.fn(), setFlagged: vi.fn(), delete: vi.fn(), pickFolder: vi.fn(), moveTo: vi.fn(), spam: vi.fn(),
    tag: vi.fn(), compose: vi.fn(), select: vi.fn(),
  });
  const run = (action, params, f = facts(), h = handlers()) => {
    const [d] = buildDescriptors({ surface: 'row', entries: [entry(action, params)], facts: f, ctx: ctx(), handlers: h });
    d.onActivate?.();
    return h;
  };

  it('routes each action to its handler', () => {
    expect(run('toggleRead').setRead).toHaveBeenCalledWith(true);
    expect(run('toggleRead', undefined, facts([row({ seen: true })])).setRead).toHaveBeenCalledWith(false);
    expect(run('markUnread').setRead).toHaveBeenCalledWith(false);
    expect(run('star').setFlagged).toHaveBeenCalledWith(true);
    expect(run('unstar').setFlagged).toHaveBeenCalledWith(false);
    expect(run('delete').delete).toHaveBeenCalled();
    expect(run('deleteServer').delete).toHaveBeenCalled();
    expect(run('move').pickFolder).toHaveBeenCalled();
    expect(run('move', { mailbox: 'Archive' }).moveTo).toHaveBeenCalledWith('Archive');
    expect(run('spam').spam).toHaveBeenCalled();
    expect(run('tag', { tagId: 't1' }).tag).toHaveBeenCalledWith('t1');
    expect(run('reply').compose).toHaveBeenCalledWith('reply');
    expect(run('replyAll').compose).toHaveBeenCalledWith('replyAll');
    expect(run('forward').compose).toHaveBeenCalledWith('forward');
  });

  it('runs nothing for an action that is on desktop', () => {
    const h = run('archive');
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });

  it('adds the phone\'s Select entry only where the caller asks for it', () => {
    const [d] = buildDescriptors({ surface: 'row', entries: [{ id: 'select', action: 'select' }], facts: facts(), ctx: ctx(), handlers: handlers() });
    expect(d.label).toBe(t('mobile.quickActions.select'));
    d.onActivate();
    const h = handlers();
    const [again] = buildDescriptors({ surface: 'row', entries: [{ id: 'select', action: 'select' }], facts: facts(), ctx: ctx(), handlers: h });
    again.onActivate();
    expect(h.select).toHaveBeenCalled();
  });
});
