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
  calls: [], handlers: new Map(), prepare: null, sendError: null, sendErrorData: undefined, outbox: [], drafts: 0,
  draftList: [], draft: null, saveError: false, sendGate: null, rescheduleError: null,
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
        if (engine.sendGate) await engine.sendGate;
        if (engine.sendError) throw Object.assign(new Error(engine.sendError), { code: engine.sendError, data: engine.sendErrorData });
        return { id: 'out_1', state: 'queued' };
      case 'mobile.drafts.save':
        if (engine.saveError) throw Object.assign(new Error('disk'), { code: 'INTERNAL' });
        engine.drafts++;
        return { id: params.id || DRAFT_ID };
      case 'mobile.drafts.delete':
        engine.draftList = engine.draftList.filter((d) => d.id !== params.id);
        return { deleted: true };
      case 'mobile.drafts.list':
        return engine.draftList;
      case 'mobile.drafts.get':
        return engine.draft;
      case 'mobile.attachment.fetch':
        return { jobId: 40 + Number(params.section) };
      case 'mobile.attachment.cancel':
        return { cancelled: true };
      case 'mobile.outbox.list':
        return engine.outbox;
      case 'mobile.outbox.retry':
        return { id: params.id, state: 'queued' };
      case 'mobile.outbox.reschedule':
        if (engine.rescheduleError) throw Object.assign(new Error(engine.rescheduleError), { code: engine.rescheduleError });
        return { id: params.id, state: 'queued', scheduledMs: params.sendAtMs };
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
  takeNotificationTap: vi.fn(async () => null),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { default: Compose } = await import('../Compose.jsx');
const { useMobileStore } = await import('../store.js');

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
  engine.sendErrorData = undefined;
  engine.outbox = [];
  engine.drafts = 0;
  engine.draftList = [];
  engine.draft = null;
  engine.saveError = false;
  engine.sendGate = null;
  engine.rescheduleError = null;
  useMobileStore.setState({ paywall: null, premium: { premium: false, source: null, expiresMs: null } });
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
      fromLabel: t('common.from'), dateFieldLabel: t('mobile.compose.quoteDate'), subjectLabel: t('compose.subject'),
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
      accountId: 'a1', to: '', cc: '', bcc: '', subject: '', text: 'Hello', inReplyTo: '', references: '', attachments: [], mode: 'new',
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
      accountId: 'a1', to: '', cc: '', bcc: '', subject: '', text: 'Draft text', inReplyTo: '', references: '', attachments: [], mode: 'new',
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
    // The engine named the account's limit (a Microsoft account's is about 2 MB): it is shown.
    engine.sendError = 'TOO_LARGE';
    engine.sendErrorData = { limitBytes: 2_400_000 };
    fireEvent.click(sendButton());
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.compose.error.TOO_LARGE_LIMIT', { size: '2.2' }));
    expect(screen.getByRole('alert').textContent).toContain('2.2');
    expect(onClose).not.toHaveBeenCalled();
    // Autosave runs again after a refused send.
    typeInto(body(), 'Still here');
    await act(async () => { vi.advanceTimersByTime(1500); });
    await flush();
    expect(callsOf('mobile.drafts.save').at(-1)).toMatchObject({ text: 'Still here' });
  });
});

describe('Compose, fix round 1', () => {
  it('a failed Save draft keeps compose open and says so', async () => {
    const { onClose } = renderCompose();
    await flush();
    typeInto(body(), 'Keep me');
    engine.saveError = true;
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.saveDraft') }));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.compose.saveFailed'));
    expect(body().value).toBe('Keep me');
    // Once the engine takes it, Save draft leaves.
    engine.saveError = false;
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.saveDraft') }));
    await flush();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a Sending state while the send is in flight', async () => {
    let open;
    engine.sendGate = new Promise((r) => { open = r; });
    const { onClose } = renderCompose();
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    fireEvent.click(sendButton());
    await flush();
    const busy = screen.getByRole('button', { name: t('mobile.compose.sending') });
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.textContent).toBe(t('mobile.compose.sending'));
    await act(async () => { open(); });
    await flush();
    expect(onClose).toHaveBeenCalled();
  });

  it('a forwarded part that stalls for 60 s fails, is left out, and Send works', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    engine.prepare = { ...EMPTY, subject: 'Fwd: Plans', pending: [{ section: '2', filename: 'plan.pdf', mime: 'application/pdf', size: 10 }] };
    renderCompose({ mode: 'forward', original: { folder: 'INBOX', uid: 7, dateMs: DATE_MS } });
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    expect(screen.getByText(t('mobile.compose.downloading'))).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(59_999); });
    expect(sendButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();
    expect(callsOf('mobile.attachment.cancel')).toEqual([{ jobId: 42 }]);
    expect(screen.getByText(t('mobile.compose.forwardMissing', { name: 'plan.pdf' }))).toBeTruthy();
    expect(sendButton().disabled).toBe(false);
  });

  it('a forwarded part still downloading can be removed, which frees Send', async () => {
    engine.prepare = { ...EMPTY, subject: 'Fwd: Plans', pending: [{ section: '2', filename: 'plan.pdf', mime: 'application/pdf', size: 10 }] };
    renderCompose({ mode: 'forward', original: { folder: 'INBOX', uid: 7, dateMs: DATE_MS } });
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.removeAttachment', { name: 'plan.pdf' }) }));
    expect(screen.queryByText(t('mobile.compose.downloading'))).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it('a reopened draft loads from mobile.drafts.get and autosaves into the same id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const id = 'drf_00000000000000aa';
    engine.draft = {
      id, accountId: 'a1', updatedMs: 1, to: 'bob@example.test', cc: '', bcc: 'carol@example.test', subject: 'Plans',
      text: 'Half done', inReplyTo: '<m1@example.test>', references: '<m1@example.test>', mode: 'reply',
      attachments: [{ handle: 'out/0123456789abcdef/a.pdf', name: 'a.pdf', size: 2048, mime: 'application/pdf' }],
    };
    const { onClose } = renderCompose({ draftId: id });
    await flush();
    expect(callsOf('mobile.drafts.get')).toEqual([{ id }]);
    // A reply draft keeps its title.
    expect(screen.getByRole('dialog', { name: t('emailActionBar.reply') })).toBeTruthy();
    expect(field(t('compose.subject')).value).toBe('Plans');
    expect(body().value).toBe('Half done');
    expect(screen.getByText('bob@example.test')).toBeTruthy();
    expect(screen.getByText('carol@example.test')).toBeTruthy();
    expect(screen.getByText('a.pdf')).toBeTruthy();
    typeInto(body(), 'Half done, now more');
    await act(async () => { vi.advanceTimersByTime(1500); });
    await flush();
    expect(callsOf('mobile.drafts.save')).toEqual([{
      id, accountId: 'a1', to: 'bob@example.test', cc: '', bcc: 'carol@example.test', subject: 'Plans',
      text: 'Half done, now more', inReplyTo: '<m1@example.test>', references: '<m1@example.test>',
      attachments: [{ handle: 'out/0123456789abcdef/a.pdf' }], mode: 'reply',
    }]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a draft that cannot be loaded is never saved over or deleted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    engine.draft = null; // the engine answers nothing usable
    const { onClose } = renderCompose({ draftId: 'drf_00000000000000aa' });
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.drafts.loadFailed'));
    expect(body().readOnly).toBe(true);
    typeInto(body(), 'Typed over');
    typeInto(toInput(), 'bob@example.test,');
    expect(body().value).toBe('');
    expect(sendButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(5000); });
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    await flush();
    expect(onClose).toHaveBeenCalled();
    expect(callsOf('mobile.drafts.save')).toEqual([]);
    expect(callsOf('mobile.drafts.delete')).toEqual([]);
  });

  it('typing before the draft is loaded changes nothing; the stored draft fills in, then autosave runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const id = 'drf_00000000000000aa';
    let answer;
    engine.draft = new Promise((r) => { answer = r; });
    renderCompose({ draftId: id });
    await flush();
    expect(body().readOnly).toBe(true);
    typeInto(body(), 'Early');
    typeInto(field(t('compose.subject')), 'Early subject');
    expect(body().value).toBe('');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(callsOf('mobile.drafts.save')).toEqual([]);
    await act(async () => {
      answer({ id, accountId: 'a1', updatedMs: 1, to: 'bob@example.test', cc: '', bcc: '', subject: 'Stored', text: 'Stored body', inReplyTo: '', references: '', mode: 'forward', attachments: [{ handle: 'out/0123456789abcdef/a.pdf', name: 'a.pdf', size: 1, mime: 'application/pdf' }] });
    });
    await flush();
    expect(body().readOnly).toBe(false);
    expect(body().value).toBe('Stored body');
    expect(field(t('compose.subject')).value).toBe('Stored');
    expect(screen.getByRole('dialog', { name: t('emailActionBar.forward') })).toBeTruthy();
    typeInto(body(), 'Stored body, more');
    await act(async () => { vi.advanceTimersByTime(1500); });
    await flush();
    expect(callsOf('mobile.drafts.save')).toEqual([expect.objectContaining({
      id, subject: 'Stored', text: 'Stored body, more', mode: 'forward', attachments: [{ handle: 'out/0123456789abcdef/a.pdf' }],
    })]);
  });

  it('a forwarded part removed while it downloads is cancelled and stays out after prepare runs again', async () => {
    const part = { section: '2', filename: 'Q3: plan.pdf', mime: 'application/pdf', size: 10 };
    const other = { section: '3', filename: 'b.txt', mime: 'text/plain', size: 5 };
    let prepares = 0;
    engine.prepare = () => {
      prepares++;
      if (prepares === 1) return { ...EMPTY, subject: 'Fwd: Plans', pending: [part, other] };
      // The engine names the copy after safe_name(filename): not the raw name.
      return {
        ...EMPTY, subject: 'Fwd: Plans', pending: [],
        attachments: [
          { handle: 'out/aaaaaaaaaaaaaaaa/Q3_ plan.pdf', name: 'Q3_ plan.pdf', size: 10, mime: 'application/pdf', section: '2' },
          { handle: 'out/bbbbbbbbbbbbbbbb/b.txt', name: 'b.txt', size: 5, mime: 'text/plain', section: '3' },
        ],
      };
    };
    renderCompose({ mode: 'forward', original: { folder: 'INBOX', uid: 7, dateMs: DATE_MS } });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.removeAttachment', { name: 'Q3: plan.pdf' }) }));
    await flush();
    expect(callsOf('mobile.attachment.cancel')).toEqual([{ jobId: 42 }]);
    // The other part finishes; prepare runs again and lists both.
    await act(async () => { emit('mobile.attachment.done', { jobId: 43 }); });
    await flush();
    expect(prepares).toBe(2);
    expect(screen.getByText('b.txt')).toBeTruthy();
    expect(screen.queryByText('Q3_ plan.pdf')).toBeNull();
  });

  it('leaving a reopened draft untouched keeps it', async () => {
    const id = 'drf_00000000000000aa';
    engine.draft = { id, accountId: 'a1', updatedMs: 1, to: '', cc: '', bcc: '', subject: 'Keep', text: 'x', inReplyTo: '', references: '', attachments: [] };
    const { onClose } = renderCompose({ draftId: id });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    await flush();
    expect(onClose).toHaveBeenCalled();
    expect(callsOf('mobile.drafts.delete')).toEqual([]);
    expect(callsOf('mobile.drafts.save')).toEqual([]);
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

describe('outbox sheet and drafts list in the app', () => {
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
  const row = (id, state) => ({ id, accountId: 'a1', subject: `Subject ${id}`, state, lastError: null });

  it('an emptied outbox closes its sheet, which does not come back by itself', async () => {
    await mount();
    engine.outbox = [row('out_1', 'failed')];
    await act(async () => { emit('mobile.send.result', { id: 'out_1', accountId: 'a1', outcome: 'failed', reason: 'REFUSED' }); });
    await waitFor(() => expect(screen.getByText(t('mobile.outbox.waiting', { count: 1 }))).toBeTruthy());
    fireEvent.click(screen.getByText(t('mobile.outbox.waiting', { count: 1 })));
    expect(screen.getByRole('dialog', { name: t('mobile.outbox.title') })).toBeTruthy();
    engine.outbox = [];
    await act(async () => { emit('mobile.send.result', { id: 'out_1', accountId: 'a1', outcome: 'sent' }); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('mobile.outbox.title') })).toBeNull());
    engine.outbox = [row('out_2', 'queued')];
    await act(async () => { emit('mobile.send.result', { id: 'out_2', accountId: 'a1', outcome: 'queued' }); });
    await waitFor(() => expect(screen.getByText(t('mobile.outbox.waiting', { count: 1 }))).toBeTruthy());
    expect(screen.queryByRole('dialog', { name: t('mobile.outbox.title') })).toBeNull();
  });

  it('the drawer lists drafts with a count; one reopens in compose and one is deleted after a confirm', async () => {
    const now = Date.now();
    engine.draftList = [
      { id: 'drf_00000000000000aa', accountId: 'a1', to: 'bob@example.test', subject: 'Plans', updatedMs: now - 60_000 },
      { id: 'drf_00000000000000bb', accountId: 'a1', to: '', subject: '', updatedMs: now - 120_000 },
      { id: 'drf_00000000000000cc', accountId: 'a2', to: 'x@example.test', subject: 'Other account', updatedMs: now },
    ];
    engine.draft = { id: 'drf_00000000000000aa', accountId: 'a1', updatedMs: 1, to: 'bob@example.test', cc: '', bcc: '', subject: 'Plans', text: 'Body', inReplyTo: '', references: '', attachments: [] };
    await mount();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.drawer.open') }));
    const entry = await waitFor(() => {
      const el = document.querySelector('[data-mv-drafts]');
      expect(el.textContent).toContain('2');
      return el;
    });
    expect(screen.getByLabelText(t('mobile.drafts.count', { count: 2 }))).toBeTruthy();
    fireEvent.click(entry);
    const list = await waitFor(() => screen.getByRole('dialog', { name: t('mobile.drafts.title') }));
    expect(list.textContent).toContain('Plans');
    expect(list.textContent).toContain('bob@example.test');
    expect(list.textContent).toContain(t('common.noSubject'));
    expect(list.textContent).not.toContain('Other account');
    // Delete asks first; Cancel keeps it.
    fireEvent.click(screen.getByRole('button', { name: t('mobile.drafts.delete', { subject: t('common.noSubject') }) }));
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(callsOf('mobile.drafts.delete')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.drafts.delete', { subject: t('common.noSubject') }) }));
    fireEvent.click(screen.getByRole('button', { name: t('common.delete') }));
    await flush();
    expect(callsOf('mobile.drafts.delete')).toEqual([{ id: 'drf_00000000000000bb' }]);
    await waitFor(() => expect(list.textContent).not.toContain(t('common.noSubject')));
    // Tapping a draft reopens it.
    fireEvent.click(screen.getByText('Plans'));
    await waitFor(() => expect(screen.getByLabelText(t('mobile.compose.body')).value).toBe('Body'));
    expect(callsOf('mobile.drafts.get')).toEqual([{ id: 'drf_00000000000000aa' }]);
  });
});

describe('Send later', () => {
  const MIN = 60_000;
  const ABOUT = /Sends at about .+ when MailVault can run/;
  const laterButton = () => screen.getByRole('button', { name: t('mobile.compose.sendLater') });
  const sheet = () => screen.getByRole('dialog', { name: t('mobile.compose.sendLater') });
  const choice = (id) => sheet().querySelector(`[data-mv-schedule="${id}"]`);
  const premiumOn = () => useMobileStore.setState({ premium: { premium: true, source: 'apple', expiresMs: Date.now() + 30 * 24 * 60 * MIN } });

  async function ready() {
    const out = renderCompose();
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    return out;
  }

  it('sends at the picked time, saying when it goes', async () => {
    const { onClose } = await ready();
    expect(laterButton().disabled).toBe(false);
    fireEvent.click(laterButton());
    expect(sheet().textContent).toMatch(ABOUT);
    expect(choice('in5').textContent).not.toContain(t('common.premium'));
    expect(choice('in1h').textContent).toContain(t('common.premium'));
    const before = Date.now();
    fireEvent.click(choice('in5'));
    await flush();
    const [sent] = callsOf('mobile.compose.send');
    expect(sent.to).toBe('bob@example.test');
    expect(sent.sendAtMs).toBeGreaterThanOrEqual(before + 5 * MIN - 1000);
    expect(sent.sendAtMs).toBeLessThanOrEqual(Date.now() + 5 * MIN);
    expect(onClose).toHaveBeenCalled();
  });

  it('a free user past five minutes gets the paywall on scheduled send, not a send', async () => {
    const { onClose } = await ready();
    fireEvent.click(laterButton());
    fireEvent.click(choice('in1h'));
    await flush();
    expect(callsOf('mobile.compose.send')).toEqual([]);
    expect(useMobileStore.getState().paywall).toMatchObject({ feature: 'scheduledSend' });
    expect(screen.queryByRole('dialog', { name: t('mobile.compose.sendLater') })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('with Premium an hour goes to the engine, and its refusal shows in place', async () => {
    premiumOn();
    engine.sendError = 'PREMIUM_REQUIRED';
    const { onClose } = await ready();
    fireEvent.click(laterButton());
    expect(choice('in1h').textContent).not.toContain(t('common.premium'));
    const before = Date.now();
    fireEvent.click(choice('in1h'));
    await flush();
    const [sent] = callsOf('mobile.compose.send');
    expect(sent.sendAtMs).toBeGreaterThanOrEqual(before + 60 * MIN - 1000);
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.compose.error.PREMIUM_REQUIRED'));
    expect(onClose).not.toHaveBeenCalled();
    engine.sendError = 'SCHEDULE_TOO_FAR';
    fireEvent.click(laterButton());
    fireEvent.click(choice('morning'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.compose.error.SCHEDULE_TOO_FAR'));
  });

  it('a picked time in the past or past a day is refused before any call', async () => {
    premiumOn();
    await ready();
    fireEvent.click(laterButton());
    const input = screen.getByLabelText(t('mobile.schedule.pick'));
    const local = (ms) => {
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const confirm = () => screen.getByRole('button', { name: t('mobile.schedule.confirm') });
    typeInto(input, local(Date.now() - 2 * 60 * MIN));
    fireEvent.click(confirm());
    expect(sheet().textContent).toContain(t('mobile.schedule.past'));
    typeInto(input, local(Date.now() + 26 * 60 * MIN));
    fireEvent.click(confirm());
    expect(sheet().textContent).toContain(t('mobile.schedule.tooFar'));
    expect(callsOf('mobile.compose.send')).toEqual([]);
    const at = local(Date.now() + 3 * 60 * MIN);
    typeInto(input, at);
    expect(sheet().textContent).toMatch(ABOUT);
    fireEvent.click(confirm());
    await flush();
    expect(callsOf('mobile.compose.send')[0].sendAtMs).toBe(new Date(at).getTime());
  });
});

describe('Follow-up reminder', () => {
  const remind = () => screen.getByLabelText(t('compose.remind.title'), { exact: false });
  const premiumOn = () => useMobileStore.setState({ premium: { premium: true, source: 'apple', expiresMs: Date.now() + 30 * 86_400_000 } });

  async function ready(props) {
    const out = renderCompose(props);
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    return out;
  }

  it('with Premium the chosen days go with the send', async () => {
    premiumOn();
    await ready();
    expect(remind().value).toBe('0');
    typeInto(remind(), '3');
    fireEvent.click(sendButton());
    await flush();
    expect(callsOf('mobile.compose.send')[0].remindAfterDays).toBe(3);
  });

  it('a reminder the engine refuses for Premium says so in place', async () => {
    premiumOn();
    engine.sendError = 'PREMIUM_REQUIRED';
    const { onClose } = await ready();
    typeInto(remind(), '1');
    fireEvent.click(sendButton());
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('compose.remind.upsell'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a free user choosing a reminder gets the paywall and it stays off', async () => {
    await ready();
    typeInto(remind(), '7');
    expect(useMobileStore.getState().paywall).toMatchObject({ feature: 'followUp' });
    expect(remind().value).toBe('0');
    fireEvent.click(sendButton());
    await flush();
    expect(callsOf('mobile.compose.send')[0]).not.toHaveProperty('remindAfterDays');
  });

  it('is not offered on a Graph account', async () => {
    useMobileStore.setState({ accounts: [{ id: 'g1', email: 'g@example.test', kind: 'graph' }] });
    await ready({ accountId: 'g1' });
    expect(screen.queryByLabelText(t('compose.remind.title'), { exact: false })).toBeNull();
    useMobileStore.setState({ accounts: [] });
  });
});

describe('scheduled in the outbox', () => {
  const HOUR = 3_600_000;
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
  const scheduledRow = (at) => ({ id: 'out_1', accountId: 'a1', subject: 'Board pack', state: 'queued', lastError: null, scheduledMs: at, notBeforeMs: at });
  const open = async () => {
    await act(async () => { emit('mobile.send.result', { id: 'out_1', accountId: 'a1', outcome: 'queued' }); });
    await waitFor(() => expect(screen.getByText(t('mobile.outbox.scheduledCount', { count: 1 }))).toBeTruthy());
    fireEvent.click(screen.getByText(t('mobile.outbox.scheduledCount', { count: 1 })));
    return screen.getByRole('dialog', { name: t('mobile.outbox.title') });
  };

  it('lists a scheduled send with its time, Change time, Send now and Cancel', async () => {
    await mount();
    engine.outbox = [scheduledRow(Date.now() + HOUR)];
    const sheet = await open();
    expect(sheet.textContent).toContain(t('mobile.outbox.scheduled'));
    expect(sheet.textContent).toMatch(/Sends at about .+ when MailVault can run/);
    expect(sheet.textContent).not.toContain(t('mobile.outbox.state.queued'));

    fireEvent.click(screen.getByRole('button', { name: t('mobile.outbox.changeTimeOf', { subject: 'Board pack' }) }));
    const picker = screen.getByRole('dialog', { name: t('mobile.outbox.changeTime') });
    const before = Date.now();
    fireEvent.click(picker.querySelector('[data-mv-schedule="in5"]'));
    await flush();
    const [moved] = callsOf('mobile.outbox.reschedule');
    expect(moved.id).toBe('out_1');
    expect(moved.sendAtMs).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
    expect(screen.getByRole('dialog', { name: t('mobile.outbox.title') })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('mobile.outbox.sendNowOf', { subject: 'Board pack' }) }));
    await flush();
    expect(callsOf('mobile.outbox.retry')).toEqual([{ id: 'out_1' }]);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.outbox.cancelOf', { subject: 'Board pack' }) }));
    await flush();
    expect(callsOf('mobile.outbox.discard')).toEqual([{ id: 'out_1' }]);
  });

  it('a refused change of time says why', async () => {
    await mount();
    engine.outbox = [scheduledRow(Date.now() + HOUR)];
    engine.rescheduleError = 'PREMIUM_REQUIRED';
    await open();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.outbox.changeTimeOf', { subject: 'Board pack' }) }));
    fireEvent.click(screen.getByRole('dialog', { name: t('mobile.outbox.changeTime') }).querySelector('[data-mv-schedule="in5"]'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(t('mobile.error.PREMIUM_REQUIRED')));
  });

  it('a row whose time passed is listed as waiting, not scheduled', async () => {
    await mount();
    engine.outbox = [scheduledRow(Date.now() - 60_000)];
    await act(async () => { emit('mobile.send.result', { id: 'out_1', accountId: 'a1', outcome: 'queued' }); });
    await waitFor(() => expect(screen.getByText(t('mobile.outbox.waiting', { count: 1 }))).toBeTruthy());
  });
});

// iOS keyboard: WKWebView keeps the layout viewport (innerHeight) and shrinks the visual viewport
// (`resize`), then pans it to the focused field (`scroll`, offsetTop > 0). A `position: fixed`
// sheet sits on the layout viewport, so the pan pushes its bar off the top of the screen.
describe('Compose over the iOS keyboard', () => {
  const saved = {};
  let vv;
  beforeEach(() => {
    saved.innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    saved.scrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    saved.scrollTo = window.scrollTo;
    saved.scrollIntoView = Element.prototype.scrollIntoView;
    vv = new EventTarget();
    vv.height = 844;
    vv.offsetTop = 0;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
    window.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    delete window.visualViewport;
    Object.defineProperty(window, 'innerHeight', saved.innerHeight);
    if (saved.scrollY) Object.defineProperty(window, 'scrollY', saved.scrollY);
    else delete window.scrollY;
    window.scrollTo = saved.scrollTo;
    if (saved.scrollIntoView) Element.prototype.scrollIntoView = saved.scrollIntoView;
    else delete Element.prototype.scrollIntoView;
  });

  // The order iOS reports it in: the shrink first (offsetTop still 0), the pan after.
  const keyboardUp = (offsetTop) => {
    act(() => {
      vv.height = 508;
      vv.dispatchEvent(new Event('resize'));
    });
    act(() => {
      vv.offsetTop = offsetTop;
      vv.dispatchEvent(new Event('scroll'));
    });
  };

  it('sizes the sheet to the visible area and adds no keyboard padding', async () => {
    renderCompose();
    await flush();
    const sheet = screen.getByRole('dialog');
    const scroller = body().parentElement;
    act(() => { field(t('compose.subject')).focus(); });
    keyboardUp(280);
    expect(sheet.style.getPropertyValue('--mv-vv-top')).toBe('280px');
    expect(sheet.style.getPropertyValue('--mv-vv-height')).toBe('508px');
    expect(sheet.hasAttribute('data-mv-keyboard')).toBe(true);
    // The sheet already ends at the keyboard: padding by its height again counts it twice.
    expect(scroller.style.getPropertyValue('--mv-keyboard')).toBe('');
    // scrollIntoView scrolls every scrollable ancestor, the document included.
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    act(() => {
      vv.height = 844;
      vv.offsetTop = 0;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(sheet.style.getPropertyValue('--mv-vv-top')).toBe('');
    expect(sheet.style.getPropertyValue('--mv-vv-height')).toBe('');
    expect(sheet.hasAttribute('data-mv-keyboard')).toBe(false);
  });

  it('puts a scrolled document back at the top', async () => {
    renderCompose();
    await flush();
    act(() => { field(t('compose.subject')).focus(); });
    window.scrollY = 120;
    keyboardUp(0);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('styles the sheet from the visual viewport, not the keyboard padding', async () => {
    // Read from disk: vitest stubs CSS imports (even `?raw`) to an empty string.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');
    expect(css.length).toBeGreaterThan(1000);
    const rule = (sel) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.mv-compose__bar')).toContain('--mv-safe-top');
    // The placement is the shared keyboard layer rule (keyboardLayers.test.jsx), which the sheet wears.
    expect(rule('.mv-kb-layer')).toContain('var(--mv-vv-height');
    expect(rule('.mv-kb-layer')).toContain('var(--mv-vv-top');
    renderCompose();
    await flush();
    expect(screen.getByRole('dialog').classList.contains('mv-kb-layer')).toBe(true);
    expect(rule('.mv-compose__scroll')).not.toContain('--mv-keyboard');
  });
});
