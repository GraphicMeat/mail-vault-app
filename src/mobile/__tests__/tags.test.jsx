// @vitest-environment jsdom
// Local labels (desktop's tags) on the phone: desktop's chips on a list row and in the viewer,
// More > Apply local label's sheet (apply, make, remove), and desktop's label list on the Quick
// actions page, all over `mobile.tags.*` (engine tags.rs). With no label at all, no row asks.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], tags: [], byKey: {} }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    const key = (i) => `${i.accountId}|${i.folder}|${i.uid}`;
    switch (method) {
      case 'mobile.tags.list':
        return { tags: engine.tags };
      case 'mobile.tags.forMessages':
        return { tags: params.items.map((i) => engine.byKey[key(i)] || []) };
      case 'mobile.tags.create': {
        const tag = { id: `t-${params.name}`, name: params.name, color: '', position: engine.tags.length, count: 0 };
        engine.tags = [...engine.tags, tag];
        return { tag, tags: engine.tags };
      }
      case 'mobile.tags.assign':
        for (const i of params.items) engine.byKey[key(i)] = [...(engine.byKey[key(i)] || []), params.tagId];
        return { count: params.items.length };
      case 'mobile.tags.unassign':
        for (const i of params.items) engine.byKey[key(i)] = (engine.byKey[key(i)] || []).filter((x) => x !== params.tagId);
        return { count: params.items.length };
      case 'mobile.tags.delete':
        engine.tags = engine.tags.filter((x) => x.id !== params.id);
        return { tags: engine.tags };
      case 'mobile.message.body':
        return { html: '<p>Hi</p>', text: null, attachments: [], remoteImages: 0, trackers: 0, gone: false };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  openFile: vi.fn(async () => {}),
  shareFile: vi.fn(async () => {}),
}));

const { default: MessageRow } = await import('../MessageRow.jsx');
const { default: Viewer } = await import('../Viewer.jsx');
const { default: Settings } = await import('../Settings.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');
const { resetTagsForTests, ensureTags } = await import('../tags.js');
/** What App.jsx does at launch: the label list, once. */
const launch = () => act(async () => { await ensureTags(); });

const WORK = { id: 't-work', name: 'Work', color: '#aabbcc', position: 0, count: 1 };
const HOME = { id: 't-home', name: 'Home', color: '', position: 1, count: 0 };
const row = { uid: 7, subject: 'Hello', fromName: 'Ada', fromAddress: 'ada@example.test', to: [], dateMs: Date.UTC(2026, 10, 3), snippet: '', seen: true, flagged: false };
const flush = () => act(async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); });
const calls = (m) => engine.calls.filter(([n]) => n === m).map(([, p]) => p);
const chips = (root = document) => [...root.querySelectorAll('.local-mail-label')].map((c) => c.textContent.replace('×', ''));

beforeEach(() => {
  engine.calls = [];
  engine.tags = [];
  engine.byKey = {};
  resetTagsForTests();
  useMobileStore.setState({ prefs: PREF_DEFAULTS, activeAccountId: 'a1', activeFolder: 'INBOX', accounts: [{ id: 'a1', email: 'u@example.test' }] });
});
afterEach(cleanup);

describe('local labels on the phone', () => {
  it('a row shows its labels after the subject, without remove buttons; with no label nothing is asked', async () => {
    await launch();
    render(<MessageRow row={row} index={0} start={0} onOpen={() => {}} />);
    await flush();
    expect(calls('mobile.tags.forMessages')).toEqual([]);
    cleanup();

    resetTagsForTests();
    engine.tags = [WORK, HOME];
    engine.byKey['a1|INBOX|7'] = ['t-work'];
    await launch();
    render(<MessageRow row={row} index={0} start={0} onOpen={() => {}} />);
    await flush();
    expect(calls('mobile.tags.forMessages')).toEqual([{ items: [{ accountId: 'a1', folder: 'INBOX', uid: 7 }] }]);
    const line = document.querySelector('.mv-row__line');
    expect(chips(line)).toEqual(['Work']);
    expect(line.querySelector('.local-mail-label').style.getPropertyValue('--tag-color')).toBe('#aabbcc');
    expect(line.querySelector('button')).toBeNull();
  });

  it('a row of All Inboxes or a search asks under its own account and folder', async () => {
    engine.tags = [WORK];
    await launch();
    render(<MessageRow row={{ ...row, accountId: 'a2', folder: 'Archive' }} index={0} start={0} onOpen={() => {}} />);
    await flush();
    expect(calls('mobile.tags.forMessages')[0].items).toEqual([{ accountId: 'a2', folder: 'Archive', uid: 7 }]);
  });

  it('the viewer shows the labels and More applies, makes and removes them', async () => {
    engine.tags = [WORK, HOME];
    engine.byKey['a1|INBOX|7'] = ['t-work'];
    await launch();
    render(<Viewer accountId="a1" folder="INBOX" row={row} onClose={() => {}} folders={[{ path: 'INBOX', name: 'INBOX', depth: 0 }]} />);
    await flush();
    expect(chips(document.querySelector('.mv-viewer__top'))).toEqual(['Work']);

    fireEvent.click(document.querySelector('[data-mv-tool="more"]'));
    fireEvent.click(document.querySelector('[data-mv-tags-open]'));
    const sheet = screen.getByRole('dialog', { name: t('quickActions.localLabels') });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Home' }));
    await flush();
    expect(calls('mobile.tags.assign')).toEqual([{ tagId: 't-home', items: [{ accountId: 'a1', folder: 'INBOX', uid: 7 }] }]);
    expect(chips(document.querySelector('.mv-viewer__top'))).toEqual(['Work', 'Home']);

    fireEvent.change(within(sheet).getByRole('textbox', { name: t('quickActions.param.labelName') }), { target: { value: 'Later' } });
    fireEvent.click(within(sheet).getByRole('button', { name: t('common.create') }));
    await flush();
    expect(calls('mobile.tags.create')).toEqual([{ name: 'Later', color: '' }]);
    expect(calls('mobile.tags.assign').at(-1)).toEqual({ tagId: 't-Later', items: [{ accountId: 'a1', folder: 'INBOX', uid: 7 }] });

    const top = document.querySelector('.mv-viewer__top');
    fireEvent.click(within(top).getByRole('button', { name: t('quickActions.removeLabel', { label: 'Work' }) }));
    await flush();
    expect(calls('mobile.tags.unassign')).toEqual([{ tagId: 't-work', items: [{ accountId: 'a1', folder: 'INBOX', uid: 7 }] }]);
    expect(chips(top)).toEqual(['Home', 'Later']);
  });

  it('a refused label goes back', async () => {
    engine.tags = [HOME];
    const { daemonCall } = await import('../transport.js');
    await launch();
    render(<Viewer accountId="a1" folder="INBOX" row={row} onClose={() => {}} />);
    await flush();
    fireEvent.click(document.querySelector('[data-mv-tool="more"]'));
    fireEvent.click(document.querySelector('[data-mv-tags-open]'));
    daemonCall.mockImplementationOnce(async () => { throw Object.assign(new Error('no'), { code: 'INTERNAL' }); });
    fireEvent.click(within(screen.getByRole('dialog', { name: t('quickActions.localLabels') })).getByRole('button', { name: 'Home' }));
    await flush();
    expect(chips(document.querySelector('.mv-viewer__top'))).toEqual([]);
  });

  it('Quick actions lists the labels as desktop does and deletes one', async () => {
    engine.tags = [WORK, HOME];
    render(<Settings onClose={() => {}} page="appearance" />);
    fireEvent.click(screen.getByRole('tab', { name: t('quickActions.title') }));
    // The labels sit under the viewer bar's tab.
    fireEvent.click(screen.getByRole('tab', { name: t('quickActions.surface.reader') }));
    await flush();
    const list = document.querySelector('.quick-actions-label-list');
    expect(within(list).getByText(t('quickActions.localLabels'))).toBeTruthy();
    expect(chips(list)).toEqual(['Work', 'Home']);
    fireEvent.click(within(list).getByRole('button', { name: t('quickActions.removeLabel', { label: 'Work' }) }));
    await flush();
    expect(calls('mobile.tags.delete')).toEqual([{ id: 't-work' }]);
    expect(chips(document.querySelector('.quick-actions-label-list'))).toEqual(['Home']);
  });
});

describe('the label cache', () => {
  it('a refused change takes back only its own rows, not a change made meanwhile', async () => {
    const { daemonCall } = await import('../transport.js');
    const { useTagStore } = await import('../tags.js');
    engine.tags = [WORK, HOME];
    await launch();
    const a = { accountId: 'a1', folder: 'INBOX', uid: 1 };
    const b = { accountId: 'a1', folder: 'INBOX', uid: 2 };
    let refuse;
    daemonCall.mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(new Error('no')); }));
    let first;
    await act(async () => { first = useTagStore.getState().setOnRows([a], 't-work', true); });
    await act(async () => { await useTagStore.getState().setOnRows([b], 't-home', true); });
    await act(async () => { refuse(); await first; });
    const byRow = useTagStore.getState().byRow;
    expect(byRow['a1|INBOX|1']).toEqual([]);
    expect(byRow['a1|INBOX|2']).toEqual(['t-home']);
  });

  it('a refused tag delete puts back the tag, not the whole list as it was', async () => {
    const { daemonCall } = await import('../transport.js');
    const { useTagStore } = await import('../tags.js');
    engine.tags = [WORK, HOME];
    await launch();
    let refuse;
    daemonCall.mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(new Error('no')); }));
    let gone;
    await act(async () => { gone = useTagStore.getState().deleteTag('t-work'); });
    await act(async () => { await useTagStore.getState().createTag('Later'); });
    await act(async () => { refuse(); await gone; });
    expect(useTagStore.getState().tags.map((x) => x.id)).toEqual(['t-work', 't-home', 't-Later']);
  });

  it('a failed refresh is asked again by the next ensureTags', async () => {
    const { daemonCall } = await import('../transport.js');
    const { refreshTags, useTagStore } = await import('../tags.js');
    engine.tags = [WORK];
    daemonCall.mockImplementationOnce(async () => { throw new Error('offline'); });
    await act(async () => { await refreshTags(); });
    expect(useTagStore.getState().tags).toEqual([]);
    await act(async () => { await ensureTags(); });
    expect(useTagStore.getState().tags.map((x) => x.id)).toEqual(['t-work']);
  });
});
