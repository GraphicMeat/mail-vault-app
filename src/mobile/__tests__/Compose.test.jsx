// @vitest-environment jsdom
// The compose screen over a fake engine: a reply prefilled by `mobile.compose.prepare`, recipients
// as chips, autosave of a local draft (and its delete when left empty), send refusals shown in
// place, and the outbox row with its Retry and Discard sheet.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';
import { formatFullDate } from '../format.js';

const DRAFT_ID = 'drf_0123456789abcdef';

const engine = vi.hoisted(() => ({
  calls: [], handlers: new Map(), prepare: null, sendError: null, outbox: [], drafts: 0,
}));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 3 };
      case 'mobile.accounts.list':
        return { accounts: [{ id: 'a1', email: 'a1@example.test', displayName: 'A' }] };
      case 'mobile.folders.list':
        return { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 0, total: 1, depth: 0, noselect: false }] };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.actions.pending':
        return { pending: [] };
      case 'mobile.messages.page':
        return {
          rows: [{ uid: 1, dateMs: 1000, subject: 'Hello', fromName: 'Ada', fromAddress: 'ada@example.test', snippet: '', seen: true }],
          nextCursor: null, total: 1, listGen: 1,
        };
      case 'mobile.compose.prepare':
        return typeof engine.prepare === 'function' ? engine.prepare(params) : engine.prepare;
      case 'mobile.compose.send':
        if (engine.sendError) throw Object.assign(new Error(engine.sendError), { code: engine.sendError });
        return { id: 'out_1', state: 'queued' };
      case 'mobile.drafts.save':
        engine.drafts++;
        return { id: DRAFT_ID };
      case 'mobile.drafts.delete':
        return { deleted: true };
      case 'mobile.outbox.list':
        return engine.outbox;
      case 'mobile.outbox.retry':
        return { id: params.id, state: 'queued' };
      case 'mobile.outbox.discard':
        engine.outbox = engine.outbox.filter((r) => r.id !== params.id);
        return { discarded: true };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn((name, handler) => {
    if (!engine.handlers.has(name)) engine.handlers.set(name, new Set());
    engine.handlers.get(name).add(handler);
    return () => engine.handlers.get(name)?.delete(handler);
  }),
  pickFiles: vi.fn(async () => []),
  openFile: vi.fn(async () => {}),
  shareFile: vi.fn(async () => {}),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { default: Compose } = await import('../Compose.jsx');

const emit = (name, payload) => { for (const h of engine.handlers.get(name) || []) h(payload); };
const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });

const EMPTY = {
  to: '', cc: '', subject: '', quote: '', quoteText: '', quotePending: false, inReplyTo: '', references: '',
  attachments: [], pending: [],
};
const QUOTE = 'Original message\nFrom: Ada Lovelace <ada@example.test>\nDate: x\nSubject: Weekly\n\n> hi\n';
const DATE_MS = Date.UTC(2026, 10, 3, 10, 0);

const field = (label) => screen.getByLabelText(label);
const toInput = () => field(t('common.to'));
const body = () => field(t('mobile.compose.body'));
const sendButton = () => screen.getByRole('button', { name: t('compose.send') });

function renderCompose(props = {}) {
  const onClose = vi.fn();
  render(<Compose accountId="a1" fromEmail="a1@example.test" mode="new" onClose={onClose} {...props} />);
  return { onClose };
}

function typeInto(el, value) {
  fireEvent.change(el, { target: { value } });
}

beforeEach(() => {
  engine.calls = [];
  engine.prepare = EMPTY;
  engine.sendError = null;
  engine.outbox = [];
  engine.drafts = 0;
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Compose', () => {
  it('reply prefills to, subject and quote from mobile.compose.prepare', async () => {
    engine.prepare = {
      ...EMPTY, to: '"Ada Lovelace" <ada@example.test>', subject: 'Re: Weekly', quote: '<p>ignored</p>',
      quoteText: QUOTE, inReplyTo: '<m1@example.test>', references: '<m0@example.test> <m1@example.test>',
    };
    renderCompose({ mode: 'reply', original: { folder: 'INBOX', uid: 7, dateMs: DATE_MS } });
    await waitFor(() => expect(field(t('compose.subject')).value).toBe('Re: Weekly'));
    expect(callsOf('mobile.compose.prepare')).toEqual([{
      accountId: 'a1', mode: 'reply', folder: 'INBOX', uid: 7,
      originalLabel: t('mobile.compose.originalMessage'), dateLabel: formatFullDate(DATE_MS),
    }]);
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(body().value).toBe(`\n\n${QUOTE}`);
    expect(screen.getByText('a1@example.test')).toBeTruthy();
    fireEvent.click(sendButton());
    await flush();
    expect(callsOf('mobile.compose.send')).toEqual([{
      accountId: 'a1', to: '"Ada Lovelace" <ada@example.test>', cc: '', bcc: '', subject: 'Re: Weekly',
      text: `\n\n${QUOTE}`, inReplyTo: '<m1@example.test>', references: '<m0@example.test> <m1@example.test>', attachments: [],
    }]);
  });

  it('commits recipients as chips and blocks send on an invalid address', async () => {
    renderCompose();
    await flush();
    // Nothing to send to yet: a To is required (Bcc only is refused by the engine too).
    expect(sendButton().disabled).toBe(true);
    typeInto(toInput(), 'bob@example.test,');
    expect(screen.getByText('bob@example.test')).toBeTruthy();
    expect(toInput().value).toBe('');
    typeInto(toInput(), 'nope ');
    const bad = screen.getByText('nope').closest('[data-mv-chip]');
    expect(bad.getAttribute('aria-invalid')).toBe('true');
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText(t('mobile.compose.invalidAddress'))).toBeTruthy();
    // Enter and blur commit too.
    typeInto(toInput(), 'carol@example.test');
    fireEvent.keyDown(toInput(), { key: 'Enter' });
    expect(screen.getByText('carol@example.test')).toBeTruthy();
    typeInto(toInput(), 'dan@example.test');
    fireEvent.blur(toInput());
    expect(screen.getByText('dan@example.test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.removeRecipient', { address: 'nope' }) }));
    expect(screen.queryByText('nope')).toBeNull();
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await flush();
    expect(callsOf('mobile.compose.send')[0].to).toBe('bob@example.test, carol@example.test, dan@example.test');
  });

  it('autosaves a draft after edits and deletes an empty one on leave', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { onClose } = renderCompose();
    await flush();
    typeInto(body(), 'Hello');
    await act(async () => { vi.advanceTimersByTime(1499); });
    expect(callsOf('mobile.drafts.save')).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();
    expect(callsOf('mobile.drafts.save')).toEqual([{
      accountId: 'a1', to: '', cc: '', bcc: '', subject: '', text: 'Hello', inReplyTo: '', references: '', attachments: [],
    }]);
    // The next save replaces the same draft.
    typeInto(body(), 'Hello there');
    await act(async () => { vi.advanceTimersByTime(1500); });
    await flush();
    expect(callsOf('mobile.drafts.save')[1]).toMatchObject({ id: DRAFT_ID, text: 'Hello there' });
    // Emptied, then left: the draft goes, and Back asks nothing.
    typeInto(body(), '');
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    await flush();
    expect(callsOf('mobile.drafts.delete')).toEqual([{ id: DRAFT_ID }]);
    expect(onClose).toHaveBeenCalled();
    const saves = callsOf('mobile.drafts.save').length;
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(callsOf('mobile.drafts.save').length).toBe(saves);
  });

  it('back with content asks to save, discard or keep editing', async () => {
    const { onClose } = renderCompose();
    await flush();
    typeInto(body(), 'Draft text');
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(screen.getByRole('button', { name: t('mobile.compose.keepEditing') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.keepEditing') }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.saveDraft') }));
    await flush();
    expect(callsOf('mobile.drafts.save')).toEqual([{
      accountId: 'a1', to: '', cc: '', bcc: '', subject: '', text: 'Draft text', inReplyTo: '', references: '', attachments: [],
    }]);
    expect(onClose).toHaveBeenCalled();
  });

  it('a send stops autosave, so no late save brings the sent draft back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { onClose } = renderCompose();
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    typeInto(body(), 'One');
    await act(async () => { vi.advanceTimersByTime(1500); });
    await flush();
    expect(engine.drafts).toBe(1);
    typeInto(body(), 'One two');
    fireEvent.click(sendButton());
    await flush();
    expect(callsOf('mobile.compose.send')).toEqual([expect.objectContaining({ draftId: DRAFT_ID, text: 'One two' })]);
    expect(onClose).toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(engine.drafts).toBe(1);
  });

  it('shows TOO_LARGE and ATTACHMENT_MISSING as translated errors without leaving compose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { onClose } = renderCompose();
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    for (const code of ['TOO_LARGE', 'ATTACHMENT_MISSING']) {
      engine.sendError = code;
      fireEvent.click(sendButton());
      await flush();
      expect(screen.getByRole('alert').textContent).toContain(t(`mobile.compose.error.${code}`));
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByLabelText(t('mobile.compose.body'))).toBeTruthy();
    }
    expect(t('mobile.compose.error.TOO_LARGE')).not.toBe('mobile.compose.error.TOO_LARGE');
    // Autosave runs again after a refused send.
    typeInto(body(), 'Still here');
    await act(async () => { vi.advanceTimersByTime(1500); });
    await flush();
    expect(callsOf('mobile.drafts.save').at(-1)).toMatchObject({ text: 'Still here' });
  });
});

describe('outbox', () => {
  let offsetHeight;
  beforeEach(() => {
    offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  });
  afterEach(() => {
    offsetHeight.mockRestore();
    vi.restoreAllMocks();
  });

  async function mount() {
    window.history.replaceState({}, '', '/mobile.html');
    vi.resetModules();
    const { default: App } = await import('../App.jsx');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await waitFor(() => expect(screen.getByText('a1@example.test')).toBeTruthy());
  }
  const row = (state) => ({ id: 'out_1', accountId: 'a1', subject: 'Quarterly numbers', state, lastError: null });

  it('shows the outbox row while a send is queued and clears it on sent', async () => {
    await mount();
    expect(screen.queryByText(t('mobile.outbox.waiting', { count: 1 }))).toBeNull();
    engine.outbox = [row('queued')];
    await act(async () => { emit('mobile.send.result', { id: 'out_1', accountId: 'a1', outcome: 'queued', reason: 'HOST_UNREACHABLE' }); });
    await waitFor(() => expect(screen.getByText(t('mobile.outbox.waiting', { count: 1 }))).toBeTruthy());
    // A queued retry is not news.
    expect(screen.queryByRole('alert')).toBeNull();
    engine.outbox = [];
    await act(async () => { emit('mobile.send.result', { id: 'out_1', accountId: 'a1', outcome: 'sent' }); });
    await waitFor(() => expect(screen.queryByText(t('mobile.outbox.waiting', { count: 1 }))).toBeNull());
  });

  it('offers Retry and Discard for an uncertain send', async () => {
    await mount();
    engine.outbox = [row('uncertain')];
    await act(async () => { emit('mobile.send.result', { id: 'out_1', accountId: 'a1', outcome: 'uncertain', reason: 'TIMEOUT' }); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(t('mobile.outbox.toast.uncertain')));
    // Once: the same outcome again shows no second toast.
    fireEvent.click(screen.getByRole('button', { name: t('mobile.actions.dismiss') }));
    await act(async () => { emit('mobile.send.result', { id: 'out_1', accountId: 'a1', outcome: 'uncertain', reason: 'TIMEOUT' }); });
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByText(t('mobile.outbox.waiting', { count: 1 })));
    const sheet = screen.getByRole('dialog', { name: t('mobile.outbox.title') });
    expect(sheet.textContent).toContain('Quarterly numbers');
    expect(sheet.textContent).toContain(t('mobile.outbox.state.uncertain'));
    fireEvent.click(screen.getByRole('button', { name: t('mobile.outbox.retry', { subject: 'Quarterly numbers' }) }));
    await flush();
    expect(callsOf('mobile.outbox.retry')).toEqual([{ id: 'out_1' }]);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.outbox.discard', { subject: 'Quarterly numbers' }) }));
    await flush();
    expect(callsOf('mobile.outbox.discard')).toEqual([{ id: 'out_1' }]);
    await waitFor(() => expect(screen.queryByText(t('mobile.outbox.waiting', { count: 1 }))).toBeNull());
  });
});
