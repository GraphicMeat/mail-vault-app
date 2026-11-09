// @vitest-environment jsdom
// "Follow up" (plan 4 Task 9): the active account's reminders from `mobile.followup.list`, the ones
// with no reply first; one opens its Sent copy and is marked seen; any can be dismissed. The drawer
// shows the entry while there are reminders, with the count that found no reply.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], items: [] }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.followup.list':
        return { items: engine.items };
      case 'mobile.followup.dismiss':
        engine.items = engine.items.filter((f) => f.id !== params.id);
        return { id: params.id };
      case 'mobile.followup.seen':
        return { id: params.id };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  pickFiles: vi.fn(async () => []),
  openFile: vi.fn(async () => {}),
  shareFile: vi.fn(async () => {}),
  takeNotificationTap: vi.fn(async () => null),
}));

const { default: FollowUpList } = await import('../FollowUpList.jsx');
const { default: FolderDrawer } = await import('../FolderDrawer.jsx');
const { useMobileStore } = await import('../store.js');

const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const DAY = 86_400_000;

const item = (id, state, extra = {}) => ({
  id, accountId: 'a1', subject: `Subject ${id}`, recipients: 'bob@example.test', sentAt: Date.now() - 3 * DAY,
  remindAt: Date.now() + DAY, state, folder: state === 'due' ? 'Sent' : null, uid: state === 'due' ? 7 : null, seen: false, ...extra,
});

beforeEach(() => {
  engine.calls = [];
  engine.items = [item('w1', 'waiting'), item('d1', 'due'), item('x9', 'due', { accountId: 'other' })];
  useMobileStore.setState({ activeAccountId: 'a1', followUps: [] });
});
afterEach(() => cleanup());

describe('FollowUpList', () => {
  it('lists the account’s reminders, no reply first, and opens or dismisses one', async () => {
    const onOpen = vi.fn();
    render(<FollowUpList onOpen={onOpen} onClose={() => {}} />);
    await flush();
    const rows = [...document.querySelectorAll('[data-mv-followup]')].map((r) => r.getAttribute('data-mv-followup'));
    expect(rows).toEqual(['d1', 'w1']);
    const due = document.querySelector('[data-mv-followup="d1"] .mv-drafts__open');
    expect(due.textContent).toContain('Subject d1');
    fireEvent.click(due);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1', folder: 'Sent', uid: 7 }));
    expect(document.querySelector('[data-mv-followup="w1"] .mv-drafts__open').disabled).toBe(true);
    fireEvent.click(document.querySelector('[data-mv-followup="w1"] [aria-label]'));
    await flush();
    expect(callsOf('mobile.followup.dismiss')).toEqual([{ id: 'w1' }]);
    expect(useMobileStore.getState().followUps.map((f) => f.id)).toEqual(['d1']);
  });

  it('marking one seen tells the engine', async () => {
    useMobileStore.getState().followUpSeen('d1');
    await flush();
    expect(callsOf('mobile.followup.seen')).toEqual([{ id: 'd1' }]);
  });

  it('the drawer shows Follow up while there are reminders, with the count of no reply', () => {
    const onFollowUps = vi.fn();
    const { rerender } = render(<FolderDrawer folders={[]} onSelect={() => {}} onClose={() => {}} followUps={0} onFollowUps={onFollowUps} />);
    expect(screen.queryByText(t('mobile.followUp.title'))).toBeNull();
    rerender(<FolderDrawer folders={[]} onSelect={() => {}} onClose={() => {}} followUps={2} followUpsDue={1} onFollowUps={onFollowUps} />);
    fireEvent.click(screen.getByText(t('mobile.followUp.title')));
    expect(onFollowUps).toHaveBeenCalled();
    expect(screen.getByLabelText(t('mobile.followUp.count', { count: 1 })).textContent).toBe('1');
  });
});
