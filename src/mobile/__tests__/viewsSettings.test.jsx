// @vitest-environment jsdom
// Settings > Views on the phone: desktop's Views page and view editor over `mobile.views.*` (engine
// views.rs). The list in the engine's order with the offline note, a row opening desktop's editor,
// New refused past the free plan (desktop's note, the paywall, never the engine's code), the
// editor's typeahead and preview reading the phone's index, and Back with edits asking first.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], views: [], refuseNew: false }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.views.list':
        return { views: engine.views };
      case 'mobile.views.save': {
        const known = engine.views.some((v) => v.id === params.view.id);
        if (!known && engine.refuseNew) throw Object.assign(new Error('PREMIUM_REQUIRED'), { code: 'PREMIUM_REQUIRED' });
        engine.views = known ? engine.views.map((v) => (v.id === params.view.id ? params.view : v)) : [...engine.views, params.view];
        return { view: params.view };
      }
      case 'mobile.views.delete':
        engine.views = engine.views.filter((v) => v.id !== params.id);
        return { views: engine.views };
      case 'mobile.views.reorder':
        engine.views = params.ids.map((id) => engine.views.find((v) => v.id === id));
        return { views: engine.views };
      case 'mobile.views.counts':
        return { counts: {} };
      case 'mobile.views.evaluate':
        return { available: true, total: 1, cursor: null, rows: [{ accountId: 'a1', folder: 'INBOX', uid: 3, subject: 'Invoice', fromName: 'Ann', fromAddress: 'ann@x.test', dateMs: Date.UTC(2026, 10, 3) }] };
      case 'mobile.views.suggestSenders':
        return { senders: [{ address: 'ann@x.test', name: '', count: 2 }] };
      case 'mobile.views.suggestTerms':
        return { terms: [] };
      case 'mobile.tags.list':
        return { tags: [] };
      case 'mobile.fields.list':
        return { fields: [] };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

const { default: Settings } = await import('../Settings.jsx');
const { default: FolderDrawer } = await import('../FolderDrawer.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');
const { resetViewsForTests } = await import('../views.js');
const { resetTagsForTests } = await import('../tags.js');
const { resetFieldsForTests } = await import('../fields.js');

const flush = () => act(async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); });
const calls = (m) => engine.calls.filter(([n]) => n === m).map(([, p]) => p);
const STARRED = { id: 'builtin-starred', name: '', icon: 'star', builtin: 'starred', position: 0, def: { starred: true } };
const BILLS = { id: 'v1', name: 'Bills', icon: 'tag', builtin: null, position: 1, def: { query: 'invoice' } };

beforeEach(() => {
  engine.calls = [];
  engine.views = [STARRED, BILLS];
  engine.refuseNew = false;
  resetViewsForTests();
  resetTagsForTests();
  resetFieldsForTests();
  useMobileStore.setState({
    prefs: PREF_DEFAULTS, activeAccountId: 'a1', activeFolder: 'INBOX', paywall: null,
    accounts: [{ id: 'a1', email: 'u@example.test' }, { id: 'a2', email: 'v@example.test' }],
    premium: { premium: false, source: null, expiresMs: null },
  });
});
afterEach(cleanup);

const openPage = async (props = {}) => {
  render(<Settings onClose={() => {}} page="views" {...props} />);
  await flush();
};

describe('Settings > Views on the phone', () => {
  // System Back is `history.back()`: jsdom traverses the entries the back stack (backStack.js)
  // pushed and fires popstate, as the Android shell does. The back stack is module state, so the
  // tests that press Back come first, before other tests' history entries pile up.
  it('a saved editor takes its Back with it: the next Back leaves the page', async () => {
    await openPage();
    fireEvent.click(screen.getByTestId('views-row-v1'));
    await flush();
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Receipts' } });
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    await flush();
    expect(screen.queryByTestId('view-editor-form')).toBeNull();
    // jsdom traverses on its own timer: the editor's entry is gone first.
    await act(async () => {
      for (let i = 0; i < 100 && window.history.state?.mvLayer !== 1; i++) await new Promise((r) => setTimeout(r, 5));
    });
    expect(window.history.state?.mvLayer).toBe(1);
    await act(async () => { window.history.back(); });
    await flush();
    expect(document.querySelector('[data-mv-settings-on]').getAttribute('data-mv-settings-on')).toBe('root');
  });

  it('Back with an edit asks first: Keep editing stays, Discard closes the editor', async () => {
    await openPage();
    fireEvent.click(screen.getByTestId('views-row-v1'));
    await flush();
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Changed' } });
    await flush();
    await act(async () => { window.history.back(); });
    await flush();
    expect(screen.getByRole('dialog', { name: t('unsaved.title') })).toBeTruthy();
    expect(document.querySelector('[data-mv-unsaved-list]').textContent).toContain(t('views.name'));
    fireEvent.click(screen.getByText(t('unsaved.keep')));
    await flush();
    expect(screen.getByTestId('view-editor-form')).toBeTruthy();
    // Back is armed again after Keep editing.
    await act(async () => { window.history.back(); });
    await flush();
    fireEvent.click(screen.getByText(t('common.discard')));
    await flush();
    expect(screen.queryByTestId('view-editor-form')).toBeNull();
    expect(calls('mobile.views.save')).toHaveLength(0);
  });

  it('the page\'s own Back asks too before it leaves an edit', async () => {
    await openPage();
    fireEvent.click(screen.getByTestId('views-row-v1'));
    await flush();
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Changed' } });
    await flush();
    fireEvent.click(document.querySelector('.mv-settings__header button'));
    await flush();
    expect(document.querySelector('[data-mv-settings-on]').getAttribute('data-mv-settings-on')).toBe('views');
    fireEvent.click(screen.getByText(t('unsaved.save')));
    await flush();
    expect(calls('mobile.views.save').at(-1).view).toMatchObject({ id: 'v1', name: 'Changed' });
    expect(document.querySelector('[data-mv-settings-on]').getAttribute('data-mv-settings-on')).toBe('root');
  });

  it('the page\'s own Back takes an untouched new view with it', async () => {
    await openPage();
    fireEvent.click(screen.getByTestId('views-new'));
    await flush();
    const made = calls('mobile.views.save').at(-1).view;
    fireEvent.click(document.querySelector('.mv-settings__header button'));
    await flush();
    expect(document.querySelector('[data-mv-settings-on]').getAttribute('data-mv-settings-on')).toBe('root');
    expect(calls('mobile.views.delete')).toEqual([{ id: made.id }]);
    expect(engine.views.some((v) => v.id === made.id)).toBe(false);
  });

  it('lists the views in order under desktop\'s page, with the free plan and the offline note', async () => {
    await openPage();
    const rows = [...document.querySelectorAll('[data-testid^="views-row-"]')].map((b) => b.textContent);
    expect(rows).toEqual([t('views.builtin.starred'), 'Bills']);
    expect(screen.getByTestId('views-limit').textContent).toBe(t('views.limit', { used: 2, max: 3 }));
    expect(document.querySelector('[data-mv-views-note]').textContent).toBe(t('mobile.views.offlineNote'));
    fireEvent.click(screen.getByTestId('views-upgrade'));
    expect(useMobileStore.getState().paywall).toEqual({ feature: null });
  });

  it('a row opens desktop\'s editor; Save writes the view through the engine', async () => {
    await openPage();
    fireEvent.click(screen.getByTestId('views-row-v1'));
    await flush();
    expect(screen.getByTestId('view-editor-form')).toBeTruthy();
    // The preview reads the phone's index with the definition on screen.
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    await flush();
    expect(calls('mobile.views.evaluate').at(-1)).toMatchObject({ def: expect.objectContaining({ query: 'invoice' }) });
    expect(screen.getByTestId('view-preview-total').textContent).toBe(t('views.preview.matches', { count: 1 }));
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Receipts' } });
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    await flush();
    expect(calls('mobile.views.save').at(-1).view).toMatchObject({ id: 'v1', name: 'Receipts', def: expect.objectContaining({ query: 'invoice' }) });
    expect(screen.queryByTestId('view-editor-form')).toBeNull();
    expect(screen.getByTestId('views-row-v1').textContent).toBe('Receipts');
  });

  it('the editor leaves out the presentation the phone list does not follow, and a save keeps it', async () => {
    engine.views = [STARRED, { ...BILLS, def: { query: 'invoice', sort: 'subject', direction: 'asc', group: 'sender', showTimeline: true } }];
    await openPage();
    fireEvent.click(screen.getByTestId('views-row-v1'));
    await flush();
    expect(screen.queryByTestId('view-sort')).toBeNull();
    expect(screen.queryByTestId('view-direction')).toBeNull();
    expect(screen.queryByTestId('view-group')).toBeNull();
    expect(screen.queryByTestId('view-show-timeline')).toBeNull();
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Receipts' } });
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    await flush();
    expect(calls('mobile.views.save').at(-1).view.def).toMatchObject({ sort: 'subject', direction: 'asc', group: 'sender', showTimeline: true });
  });

  it('the sender typeahead asks the phone\'s index for the accounts the view reads', async () => {
    await openPage();
    fireEvent.click(screen.getByTestId('views-row-v1'));
    await flush();
    fireEvent.change(screen.getByTestId('view-sender'), { target: { value: 'an' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    await flush();
    expect(calls('mobile.views.suggestSenders').at(-1)).toEqual({ prefix: 'an', accounts: ['a1', 'a2'], limit: 8 });
    expect(screen.getByRole('listbox').textContent).toContain('ann@x.test');
  });

  it('New makes a view and opens it; past the free plan it shows desktop\'s note and the paywall', async () => {
    await openPage();
    fireEvent.click(screen.getByTestId('views-new'));
    await flush();
    const made = calls('mobile.views.save').at(-1).view;
    expect(made).toMatchObject({ name: t('views.new'), builtin: null, def: {} });
    expect(screen.getByTestId('view-editor-form')).toBeTruthy();
    expect(screen.getByTestId('views-new').disabled).toBe(true);
    cleanup();

    // The engine is the judge: a refusal it gives is desktop's note and the paywall, never its code.
    resetViewsForTests();
    engine.views = [STARRED, BILLS];
    engine.refuseNew = true;
    await openPage();
    fireEvent.click(screen.getByTestId('views-new'));
    await flush();
    expect(screen.getByTestId('views-refused').textContent).toBe(t('views.limitReached', { max: 3 }));
    expect(document.body.textContent).not.toContain('PREMIUM_REQUIRED');
    expect(useMobileStore.getState().paywall).toEqual({ feature: null });
    expect(screen.queryByTestId('view-editor-form')).toBeNull();
  });

  it('the drawer\'s + opens the page on a new view', async () => {
    await openPage({ newView: true });
    expect(calls('mobile.views.save')).toHaveLength(1);
    expect(screen.getByTestId('view-editor-form')).toBeTruthy();
  });

  it('the drawer\'s Views heading has desktop\'s Edit and New, with no view too', () => {
    const onEditViews = vi.fn();
    const onNewView = vi.fn();
    render(<FolderDrawer account={null} folders={[]} onSelect={() => {}} onClose={() => {}} views={[]} onView={() => {}}
      onEditViews={onEditViews} onNewView={onNewView} />);
    fireEvent.click(screen.getByRole('button', { name: t('views.edit') }));
    fireEvent.click(screen.getByRole('button', { name: t('views.new') }));
    expect(onEditViews).toHaveBeenCalledTimes(1);
    expect(onNewView).toHaveBeenCalledTimes(1);
  });
});
