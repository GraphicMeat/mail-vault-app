// @vitest-environment jsdom
// Settings > Auto Tags on the phone: desktop's view over the engine's rules (`mobile.autoTags.*`).
// The remote opt-in goes through the AI actions' review sheet naming the phone's endpoint, and is
// saved as the rule's provider; a rule that cannot run here says so; the page says when there is
// no endpoint, and that Gmail mail is never sent to one off the phone; Preview runs only when
// pressed; a backfill's progress is the engine's event; Hide from Inbox is not offered.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, within, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], rules: [], status: null, listeners: {}, preview: null }));
const URL = 'https://ai.example.test/v1';

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.autoTags.list':
        return { rules: structuredClone(engine.rules) };
      case 'mobile.autoTags.status':
        return structuredClone(engine.status);
      case 'mobile.autoTags.update': {
        const rule = { ...engine.rules.find((r) => r.id === params.id), ...params.rule };
        engine.rules = engine.rules.map((r) => (r.id === params.id ? rule : r));
        return { rule, rules: structuredClone(engine.rules) };
      }
      case 'mobile.autoTags.preview':
        return engine.preview;
      case 'mobile.autoTags.backfill':
        return { batchId: 'batch-1' };
      case 'mobile.autoTags.undoBackfill':
        return { unassigned: 1, tagId: 't1' };
      case 'mobile.tags.list':
        return { tags: [{ id: 't1', name: 'Receipts', color: '', position: 0, count: 0 }] };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn((name, handler) => {
    (engine.listeners[name] ||= []).push(handler);
    return () => { engine.listeners[name] = engine.listeners[name].filter((h) => h !== handler); };
  }),
}));

const { default: AutoTags } = await import('../settings/AutoTags.jsx');
const { MobileViewEnv } = await import('../settings/MobileViewEnv.jsx');
const { useMobileStore } = await import('../store.js');
const { useTagStore, resetTagsForTests } = await import('../tags.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const RULE = {
  id: 'r1', name: 'Receipts', instruction: 'receipts and invoices', constraints: { fromDomain: 'shop.example' }, tagId: 't1',
  inboxAction: 'hide', minConfidence: 0.7, allowRemote: false, provider: null, enabled: true, enabledAt: 1, createdAt: 1, updatedAt: 1,
};
const emit = (name, payload) => act(() => { for (const h of engine.listeners[name] || []) h(payload); });
const page = () => render(<MobileViewEnv><AutoTags /></MobileViewEnv>);
const called = (method) => engine.calls.filter(([m]) => m === method);

beforeEach(() => {
  engine.calls = [];
  engine.rules = [structuredClone(RULE)];
  engine.status = { configured: true, leavesDevice: true, googleSkipped: [], backfills: {} };
  engine.listeners = {};
  engine.preview = { candidates: [] };
  resetTagsForTests();
  useTagStore.setState({ tags: [{ id: 't1', name: 'Receipts', color: '', position: 0, count: 0 }] });
  useMobileStore.setState({
    prefs: { ...PREF_DEFAULTS, aiEndpointUrl: URL, aiEndpointModel: 'm' },
    accounts: [{ id: 'a1', email: 'ann@example.com' }, { id: 'g1', email: 'ann@gmail.com' }],
  });
});
afterEach(cleanup);

describe('Settings > Auto Tags on the phone', () => {
  it('lists the engine\'s rules in desktop\'s view, in the phone\'s words, without Hide from Inbox', async () => {
    page();
    expect(await screen.findByText('receipts and invoices')).toBeTruthy();
    expect(screen.getByText(t('mobile.autoTag.intro'))).toBeTruthy();
    expect(screen.queryByText(t('autoTag.intro'))).toBeNull();
    expect(screen.queryByText(t('autoTag.inboxActionHide'))).toBeNull();
    fireEvent.click(screen.getByTitle(t('autoTag.edit')));
    expect(screen.getByLabelText(t('autoTag.name')).value).toBe('Receipts');
    expect(screen.queryByText(t('autoTag.inboxAction'))).toBeNull();
    expect(screen.getByText(t('mobile.autoTag.allowRemoteHint'))).toBeTruthy();
  });

  it('says a rule without the opt-in for this endpoint does not run here, and the opt-in names the endpoint first', async () => {
    page();
    expect((await screen.findByTestId('auto-tag-note-r1')).textContent).toBe(t('mobile.autoTag.needsRemote'));
    fireEvent.click(screen.getByTitle(t('autoTag.edit')));
    fireEvent.click(screen.getByTestId('auto-tag-allow-remote'));
    // Not on yet: the review sheet names where the mail goes and what goes.
    expect(screen.getByTestId('auto-tag-allow-remote').getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('[data-mv-ai-destination]').textContent).toContain(URL);
    expect(document.querySelector('[data-mv-ai-prompt]').textContent).toContain('Subject: Your receipt for order 1041');
    fireEvent.click(document.querySelector('[data-mv-ai-send]'));
    expect(screen.getByTestId('auto-tag-allow-remote').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByText(t('common.save')));
    await waitFor(() => expect(called('mobile.autoTags.update')).toHaveLength(1));
    const saved = called('mobile.autoTags.update')[0][1];
    expect(saved.id).toBe('r1');
    expect(saved.rule).toMatchObject({
      allowRemote: true, provider: { type: 'endpoint', url: URL, model: 'm' },
      inboxAction: 'hide', constraints: { fromDomain: 'shop.example' }, enabled: true,
    });
    await waitFor(() => expect(screen.queryByTestId('auto-tag-note-r1')).toBeNull());
  });

  it('says when there is no endpoint, and when Gmail mail is left out', async () => {
    engine.status = { configured: false, leavesDevice: false, googleSkipped: [], backfills: {} };
    const first = page();
    expect(await screen.findByText(t('mobile.ai.notConfigured'))).toBeTruthy();
    first.unmount();
    engine.status = { configured: true, leavesDevice: true, googleSkipped: ['g1'], backfills: {} };
    page();
    expect(await screen.findByText(t('mobile.ai.googleNote'))).toBeTruthy();
  });

  it('previews only when pressed, and shows a refusal in the phone\'s words', async () => {
    engine.rules = [{ ...structuredClone(RULE), allowRemote: true, provider: { type: 'endpoint', url: URL, model: 'm' } }];
    engine.preview = { candidates: [{ accountId: 'a1', folder: 'INBOX', mailbox: 'INBOX', uid: 1, subject: 'Your receipt', matched: true, confidence: 0.9, refused: null }] };
    page();
    fireEvent.click(await screen.findByTitle(t('autoTag.edit')));
    await act(async () => { await new Promise((r) => setTimeout(r, 1700)); });
    expect(called('mobile.autoTags.preview')).toHaveLength(0);
    fireEvent.click(screen.getByText(t('autoTag.preview')));
    const results = await screen.findByTestId('auto-tag-preview-results');
    expect(within(results).getByText('Your receipt')).toBeTruthy();
    expect(within(results).getByText(t('autoTag.confidence', { value: 90 }))).toBeTruthy();
    expect(called('mobile.autoTags.preview')[0][1]).toMatchObject({ accountId: 'a1', rule: { instruction: 'receipts and invoices' } });

    engine.preview = { ok: false, code: 'E_GOOGLE_MAIL_ON_DEVICE_ONLY' };
    fireEvent.click(screen.getByText(t('autoTag.preview')));
    expect(await screen.findByText(t('mobile.ai.googleRefused'))).toBeTruthy();
  });

  it('runs a backfill on the engine, follows its progress, and undoes it', async () => {
    engine.rules = [{ ...structuredClone(RULE), allowRemote: true, provider: { type: 'endpoint', url: URL, model: 'm' } }];
    page();
    fireEvent.click(await screen.findByTitle(t('autoTag.edit')));
    fireEvent.click(screen.getByText(t('autoTag.backfill')));
    await waitFor(() => expect(called('mobile.autoTags.backfill')).toHaveLength(1));
    emit('mobile.autoTags.progress', { batchId: 'batch-1', ruleId: 'r1', processed: 10, total: 40, matched: 2, done: false });
    expect(screen.getByTestId('auto-tag-backfill-status').textContent).toBe(t('autoTag.backfillRunning', { processed: 10, total: 40 }));
    emit('mobile.autoTags.progress', { batchId: 'batch-1', ruleId: 'r1', processed: 40, total: 40, matched: 3, done: true, assigned: 3 });
    expect(screen.getByTestId('auto-tag-backfill-status').textContent).toBe(t('autoTag.backfillDone', { assigned: 3, processed: 40 }));
    fireEvent.click(screen.getByText(t('autoTag.undo')));
    await waitFor(() => expect(called('mobile.autoTags.undoBackfill')[0][1]).toEqual({ batchId: 'batch-1' }));
    await waitFor(() => expect(screen.queryByTestId('auto-tag-backfill-status')).toBeNull());
  });

  it('a tag the engine assigns joins a row on screen', async () => {
    const { applyAssigned } = await import('../tags.js');
    useTagStore.setState({ byRow: { 'a1|INBOX|7': [] } });
    applyAssigned({ tagId: 't1', items: [{ accountId: 'a1', folder: 'INBOX', uid: 7 }, { accountId: 'a1', folder: 'INBOX', uid: 8 }] });
    expect(useTagStore.getState().byRow).toEqual({ 'a1|INBOX|7': ['t1'] });
  });
});
