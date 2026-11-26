// @vitest-environment jsdom
// The compose screen over a fake engine: a reply prefilled by `mobile.compose.prepare`, recipients
// as chips, autosave of a local draft (and its delete when left empty), send refusals shown in
// place, and the outbox row with its Retry and Discard sheet.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react';
import { t } from '../i18n.js';
import { formatFullDate } from '../format.js';

const DRAFT_ID = 'drf_0123456789abcdef';

const engine = vi.hoisted(() => ({
  calls: [], handlers: new Map(), prepare: null, sendError: null, sendErrorData: undefined, outbox: [], drafts: 0,
  draftList: [], draft: null, saveError: false, sendGate: null, rescheduleError: null, accountSettings: null,
  undoState: 'queued',
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
      case 'mobile.accountSettings.get':
        return engine.accountSettings || { accountId: params.accountId, signature: null };
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
      case 'mobile.outbox.undo':
        // Only a row still waiting is taken back; one sent or on its way stays.
        if (engine.undoState !== 'queued') return { undone: false, state: engine.undoState };
        engine.outbox = engine.outbox.filter((r) => r.id !== params.id);
        return { undone: true, state: 'queued' };
      case 'mobile.ai.prompt':
        return { ok: true, prompt: `prompt for ${params.action}`, destination: 'https://ai.example.test/v1', leavesDevice: true };
      case 'mobile.ai.run':
        return { ok: true, text: `AI ${params.action}` };
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
  engine.undoState = 'queued';
  engine.rescheduleError = null;
  engine.accountSettings = null;
  useMobileStore.setState({ paywall: null, premium: { premium: false, source: null, expiresMs: null } });
  useMobileStore.setState((st) => ({ prefs: { ...st.prefs, sendDelay: 0 }, undoSend: null, reopenDraft: null }));
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
  const premiumOn = () => useMobileStore.setState({ premium: { premium: true, source: 'apple', expiresMs: Date.now() + 30 * 86_400_000 } });
  const openFollowUp = () => fireEvent.click(document.querySelector('[data-mv-followup-open]'));
  const choice = (days) => document.querySelector(`[data-mv-remind-choice="${days}"]`);
  const chip = () => document.querySelector('[data-mv-followup-chip]');
  const setRemind = (days) => { openFollowUp(); fireEvent.click(choice(days)); };

  async function ready(props) {
    const out = renderCompose(props);
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    return out;
  }

  it('a labelled Follow up button opens a sheet that says what it does, with Off, 1 day, 3 days and 1 week', async () => {
    premiumOn();
    await ready();
    const button = screen.getByRole('button', { name: t('mobile.compose.followUp') });
    expect(button.textContent).toContain(t('mobile.compose.followUp'));
    expect(document.querySelector('select')).toBeNull();
    fireEvent.click(button);
    const sheet = screen.getByRole('dialog', { name: t('compose.remind.title') });
    expect(within(sheet).getByText(t('mobile.compose.followUpHint'))).toBeTruthy();
    expect([...sheet.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual([
      t('compose.remind.off'), t('compose.remind.days1'), t('compose.remind.days3'), t('compose.remind.days7'),
    ]);
    expect(choice(0).getAttribute('aria-checked')).toBe('true');
    expect(chip()).toBeNull();
  });

  it('with Premium the chosen days go with the send, and a chip above the toolbar says so', async () => {
    premiumOn();
    await ready();
    setRemind(3);
    // The sheet closes on a pick; the chip sits right above the toolbar.
    expect(screen.queryByRole('dialog', { name: t('compose.remind.title') })).toBeNull();
    expect(chip().textContent).toContain(t('mobile.compose.followUpSet', { duration: t('compose.remind.days3') }));
    expect(chip().nextElementSibling).toBe(screen.getByRole('toolbar'));
    fireEvent.click(sendButton());
    await flush();
    expect(callsOf('mobile.compose.send')[0].remindAfterDays).toBe(3);
  });

  it('the chip\'s cross clears the reminder, and the sheet shows the choice that is set', async () => {
    premiumOn();
    await ready();
    setRemind(7);
    openFollowUp();
    expect(choice(7).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(choice(7));
    fireEvent.click(within(chip()).getByRole('button', { name: t('mobile.compose.followUpClear') }));
    expect(chip()).toBeNull();
    fireEvent.click(sendButton());
    await flush();
    expect(callsOf('mobile.compose.send')[0]).not.toHaveProperty('remindAfterDays');
  });

  it('a reminder the engine refuses for Premium says so in place', async () => {
    premiumOn();
    engine.sendError = 'PREMIUM_REQUIRED';
    const { onClose } = await ready();
    setRemind(1);
    fireEvent.click(sendButton());
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('compose.remind.upsell'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a free user choosing a reminder gets the paywall and it stays off', async () => {
    await ready();
    openFollowUp();
    // Each day count carries the Premium badge; Off does not.
    expect(choice(7).textContent).toContain(t('common.premium'));
    expect(choice(0).textContent).not.toContain(t('common.premium'));
    fireEvent.click(choice(7));
    expect(useMobileStore.getState().paywall).toMatchObject({ feature: 'followUp' });
    expect(chip()).toBeNull();
    fireEvent.click(sendButton());
    await flush();
    expect(callsOf('mobile.compose.send')[0]).not.toHaveProperty('remindAfterDays');
  });

  it('is not offered on a Graph account', async () => {
    useMobileStore.setState({ accounts: [{ id: 'g1', email: 'g@example.test', kind: 'graph' }] });
    await ready({ accountId: 'g1' });
    expect(document.querySelector('[data-mv-followup-open]')).toBeNull();
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

describe('Signature and undo send (desktop settings)', () => {
  const SIG = { html: '<p>Ann <b>Example</b></p>', text: '', enabled: true };

  it('a new message starts with the account signature, as text', async () => {
    engine.accountSettings = { accountId: 'a1', signature: SIG };
    renderCompose();
    await waitFor(() => expect(body().value).toBe('\n\n-- \nAnn Example'));
    expect(callsOf('mobile.accountSettings.get')).toEqual([{ accountId: 'a1' }]);
  });

  it('a reply puts the signature between the room to write and the quote', async () => {
    engine.accountSettings = { accountId: 'a1', signature: { html: '', text: 'Ann', enabled: true } };
    engine.prepare = { ...EMPTY, subject: 'Re: Weekly', quoteText: QUOTE };
    renderCompose({ mode: 'reply', original: { folder: 'INBOX', uid: 7, dateMs: DATE_MS } });
    await waitFor(() => expect(body().value).toBe(`\n\n-- \nAnn\n\n${QUOTE}`));
  });

  it('no signature when its switch is off or a draft reopens', async () => {
    engine.accountSettings = { accountId: 'a1', signature: { ...SIG, enabled: false } };
    renderCompose();
    await flush();
    expect(body().value).toBe('');
    cleanup();
    // A stored signatures-overall preference (an old import) no longer turns the account's own off.
    engine.accountSettings = { accountId: 'a1', signature: SIG };
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, defaultSignatureEnabled: false } }));
    renderCompose();
    await waitFor(() => expect(body().value).toContain('-- '));
    cleanup();
    engine.draft = { id: DRAFT_ID, accountId: 'a1', to: '', cc: '', bcc: '', subject: 'Kept', text: 'Draft body', attachments: [] };
    renderCompose({ draftId: DRAFT_ID });
    await waitFor(() => expect(body().value).toBe('Draft body'));
    await flush();
    expect(body().value).toBe('Draft body');
    // Each screen reads the account's settings once; a reopened draft only for its From choices.
    expect(callsOf('mobile.accountSettings.get')).toHaveLength(3);
  });

  it('sendDelay holds the message and Undo brings it back as a draft', async () => {
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, sendDelay: 10 } }));
    const { onClose } = renderCompose();
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    typeInto(field(t('compose.subject')), 'Hi');
    const before = Date.now();
    fireEvent.click(sendButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [sent] = callsOf('mobile.compose.send');
    expect(sent.sendAtMs).toBeGreaterThanOrEqual(before + 10_000);
    expect(sent.sendAtMs).toBeLessThan(before + 15_000);
    const held = useMobileStore.getState().undoSend;
    expect(held).toMatchObject({ id: 'out_1', accountId: 'a1' });
    engine.outbox = [{ id: 'out_1', accountId: 'a1', subject: 'Hi', state: 'queued' }];
    await act(async () => { await useMobileStore.getState().undoSendNow(); });
    expect(callsOf('mobile.drafts.save').at(-1)).toMatchObject({ accountId: 'a1', subject: 'Hi', to: 'bob@example.test' });
    expect(callsOf('mobile.outbox.undo')).toEqual([{ id: 'out_1' }]);
    expect(callsOf('mobile.outbox.discard')).toEqual([]);
    expect(useMobileStore.getState().reopenDraft).toEqual({ accountId: 'a1', draftId: DRAFT_ID });
    expect(useMobileStore.getState().undoSend).toBe(null);
  });

  it('the Undo offer ends when the message is due, not a full delay after the send answered', async () => {
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, sendDelay: 10 } }));
    let open;
    engine.sendGate = new Promise((resolve) => { open = resolve; });
    const { onClose } = renderCompose();
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    fireEvent.click(sendButton());
    await flush();
    // The engine answers late: the message is due sooner than 10 s from now.
    await new Promise((r) => setTimeout(r, 80));
    open();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [sent] = callsOf('mobile.compose.send');
    expect(useMobileStore.getState().undoSend.until).toBe(sent.sendAtMs);
  });

  it('an Undo after the message went out says so and brings back no draft', async () => {
    for (const state of ['sent', 'uncertain', 'sending']) {
      engine.calls = [];
      engine.undoState = state;
      useMobileStore.setState({ notice: null, reopenDraft: null });
      useMobileStore.getState().offerUndoSend('out_1', 'a1', { to: 'bob@example.test', subject: 'Hi' }, Date.now() + 10_000);
      let undone;
      await act(async () => { undone = await useMobileStore.getState().undoSendNow(); });
      expect(undone).toBe(false);
      expect(callsOf('mobile.outbox.discard')).toEqual([]);
      expect(useMobileStore.getState().reopenDraft).toBe(null);
      // The draft saved for the undo is a second copy: it goes.
      expect(callsOf('mobile.drafts.delete')).toEqual([{ id: DRAFT_ID }]);
      expect(useMobileStore.getState().notice?.key).toBe('mobile.undoSend.tooLate');
    }
  });

  it('an Undo whose draft cannot be saved keeps the message and says it will be sent', async () => {
    engine.saveError = true;
    engine.outbox = [{ id: 'out_1', accountId: 'a1', subject: 'Hi', state: 'queued' }];
    useMobileStore.setState({ notice: null, reopenDraft: null });
    useMobileStore.getState().offerUndoSend('out_1', 'a1', { to: 'bob@example.test', subject: 'Hi' }, Date.now() + 10_000);
    let undone;
    await act(async () => { undone = await useMobileStore.getState().undoSendNow(); });
    expect(undone).toBe(false);
    expect(callsOf('mobile.outbox.undo')).toEqual([]);
    expect(callsOf('mobile.outbox.discard')).toEqual([]);
    expect(engine.outbox).toHaveLength(1);
    expect(useMobileStore.getState().reopenDraft).toBe(null);
    expect(useMobileStore.getState().notice?.key).toBe('mobile.undoSend.saveFailed');
  });

  it('without a delay a send goes at once, with no undo offer', async () => {
    const { onClose } = renderCompose();
    await flush();
    typeInto(toInput(), 'bob@example.test,');
    fireEvent.click(sendButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(callsOf('mobile.compose.send')[0].sendAtMs).toBeUndefined();
    expect(useMobileStore.getState().undoSend).toBe(null);
  });
});

describe('Compose with AI (Settings > AI)', () => {
  const reply = () => {
    engine.prepare = { ...EMPTY, to: 'ada@example.test', subject: 'Re: Weekly', quoteText: QUOTE };
    return { mode: 'reply', original: { folder: 'INBOX', uid: 7, dateMs: DATE_MS } };
  };
  const pick = async (action) => {
    fireEvent.click(document.querySelector('[data-mv-ai-open]'));
    await act(async () => { fireEvent.click(document.querySelector(`[data-mv-ai-action="${action}"]`)); });
    await flush();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-ai-send]')); });
    await flush();
  };

  it('a reply opened with a starter has it at the top of the body', async () => {
    renderCompose({ ...reply(), starter: 'Sounds good' });
    await waitFor(() => expect(body().value).toBe(`Sounds good\n\n${QUOTE}`));
  });

  it('offers nothing while AI is off', async () => {
    renderCompose(reply());
    await waitFor(() => expect(body().value).toBe(`\n\n${QUOTE}`));
    expect(document.querySelector('[data-mv-ai-open]')).toBeNull();
  });

  it('a rewrite replaces what the user wrote and keeps the quote; a summary goes on top', async () => {
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, aiEnabled: true } }));
    renderCompose(reply());
    await waitFor(() => expect(body().value).toBe(`\n\n${QUOTE}`));
    typeInto(body(), `hey send it\n\n${QUOTE}`);
    await pick('tone:formal');
    expect(callsOf('mobile.ai.run')[0]).toEqual({ action: 'tone', tone: 'formal', accountId: 'a1', text: 'hey send it', confirmed: true });
    expect(body().value).toBe(`AI tone\n\n${QUOTE}`);
    await pick('summarize');
    expect(callsOf('mobile.ai.run')[1]).toEqual({ action: 'summarize', accountId: 'a1', folder: 'INBOX', uid: 7, confirmed: true });
    expect(body().value).toBe(`AI summarize\n\nAI tone\n\n${QUOTE}`);
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, aiEnabled: false } }));
  });

  it('a rewrite or a drafted reply keeps the signature: AI sees only what the user wrote', async () => {
    engine.accountSettings = { accountId: 'a1', signature: { html: '', text: 'Ann', enabled: true } };
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, aiEnabled: true } }));
    renderCompose(reply());
    await waitFor(() => expect(body().value).toBe(`\n\n-- \nAnn\n\n${QUOTE}`));
    typeInto(body(), `hey send it\n\n-- \nAnn\n\n${QUOTE}`);
    await pick('tone:formal');
    expect(callsOf('mobile.ai.run')[0]).toEqual({ action: 'tone', tone: 'formal', accountId: 'a1', text: 'hey send it', confirmed: true });
    expect(body().value).toBe(`AI tone\n\n-- \nAnn\n\n${QUOTE}`);
    await pick('draftReply');
    expect(body().value).toBe(`AI draftReply\n\n-- \nAnn\n\n${QUOTE}`);
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, aiEnabled: false } }));
  });

  it('Shorten on a new message keeps the signature under the result', async () => {
    engine.accountSettings = { accountId: 'a1', signature: { html: '', text: 'Ann', enabled: true } };
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, aiEnabled: true } }));
    renderCompose();
    await waitFor(() => expect(body().value).toBe('\n\n-- \nAnn'));
    typeInto(body(), 'a long note\n\n-- \nAnn');
    await pick('shorten');
    expect(callsOf('mobile.ai.run')[0]).toEqual({ action: 'shorten', accountId: 'a1', text: 'a long note', confirmed: true });
    expect(body().value).toBe('AI shorten\n\n-- \nAnn');
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, aiEnabled: false } }));
  });
});

describe('layout: the bar, the toolbar above the keyboard, the fields', () => {
  const premiumOn = () => useMobileStore.setState({ premium: { premium: true, source: 'apple', expiresMs: Date.now() + 30 * 86_400_000 } });
  const toolbar = () => screen.getByRole('toolbar');
  const toolNames = () => Array.from(toolbar().querySelectorAll('button')).map((el) => el.getAttribute('aria-label'));
  afterEach(() => {
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, templates: [], aiEnabled: false }, accounts: [] }));
  });

  it('the top bar holds only Back, the title and Send', async () => {
    renderCompose();
    await flush();
    const bar = document.querySelector('.mv-compose__bar');
    const names = within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([t('common.back'), t('compose.send')]);
    expect(within(bar).getByRole('heading').textContent).toBe(t('mobile.compose.newTitle'));
  });

  it('the tools sit in a toolbar under the form, Templates and AI only when there are any and it is on', async () => {
    renderCompose();
    await flush();
    const bar = toolbar();
    // A footer of the screen itself, not part of what scrolls.
    expect(bar.parentElement).toBe(screen.getByRole('dialog'));
    expect(bar.closest('.mv-compose__scroll')).toBeNull();
    expect(document.querySelector('.mv-compose__scroll').nextElementSibling).toBe(bar);
    expect(toolNames()).toEqual([t('mobile.compose.attach'), t('mobile.compose.sendLater'), t('mobile.compose.followUp')]);
    expect(bar.querySelector('[data-mv-send-later-open]')).toBeTruthy();
    expect(bar.querySelector('[data-mv-templates-open]')).toBeNull();
    expect(bar.querySelector('[data-mv-ai-open]')).toBeNull();
    cleanup();
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, templates: [{ name: 'Thanks', body: 'Thank you!' }], aiEnabled: true } }));
    renderCompose();
    await flush();
    expect(toolNames()).toEqual([
      t('mobile.compose.attach'), t('mobile.compose.sendLater'), t('compose.templates'), t('settings.tab.aiProviders'), t('mobile.compose.followUp'),
    ]);
    expect(toolbar().querySelector('[data-mv-templates-open]')).toBeTruthy();
    expect(toolbar().querySelector('[data-mv-ai-open]')).toBeTruthy();
    // Send later waits for a To, as Send does.
    expect(toolbar().querySelector('[data-mv-send-later-open]').disabled).toBe(true);
    typeInto(toInput(), 'bob@example.test,');
    expect(toolbar().querySelector('[data-mv-send-later-open]').disabled).toBe(false);
  });

  it('a Graph account has no Follow up tool', async () => {
    useMobileStore.setState({ accounts: [{ id: 'g1', email: 'g@example.test', kind: 'graph' }] });
    renderCompose({ accountId: 'g1' });
    await flush();
    expect(toolNames()).toEqual([t('mobile.compose.attach'), t('mobile.compose.sendLater')]);
  });

  it('every tool carries a caption under its icon, in desktop\'s words where it has them', async () => {
    useMobileStore.setState((st) => ({ prefs: { ...st.prefs, templates: [{ name: 'Thanks', body: 'Thank you!' }], aiEnabled: true } }));
    renderCompose();
    await flush();
    const captions = Array.from(toolbar().querySelectorAll('button')).map((b) => b.querySelector('.mv-compose__tool-caption')?.textContent);
    expect(captions).toEqual([
      t('mobile.compose.attach'), t('mobile.compose.later'), t('compose.templates'), t('settings.tab.aiProviders'), t('mobile.compose.followUp'),
    ]);
    for (const b of toolbar().querySelectorAll('button')) expect(b.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  });

  it('Follow up is marked while a reminder is set', async () => {
    premiumOn();
    renderCompose();
    await flush();
    const tool = document.querySelector('[data-mv-followup-open]');
    expect(tool.hasAttribute('data-mv-active')).toBe(false);
    fireEvent.click(tool);
    fireEvent.click(document.querySelector('[data-mv-remind-choice="3"]'));
    expect(tool.hasAttribute('data-mv-active')).toBe(true);
  });

  it('the Cc/Bcc toggle sits at the end of the To line', async () => {
    renderCompose();
    await flush();
    const toLine = toInput().closest('.mv-compose__line');
    const toggle = within(toLine).getByRole('button', { name: t('mobile.compose.showCc') });
    fireEvent.click(toggle);
    expect(screen.getByLabelText(t('mobile.compose.cc'))).toBeTruthy();
    expect(screen.getByLabelText(t('mobile.compose.bcc'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('mobile.compose.showCc') })).toBeNull();
  });

  it('the body says what to write there', async () => {
    renderCompose();
    await flush();
    expect(body().getAttribute('placeholder')).toBe(t('compose.writeMessage'));
  });

  it('styles: the toolbar is a footer above the keyboard, and From never outgrows its line', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');
    const rule = (sel) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
    const tools = rule('.mv-compose__tools');
    expect(tools).toContain('flex: none');
    expect(tools).toContain('border-top: 1px solid var(--mail-border)');
    expect(tools).toContain('var(--mv-safe-bottom)');
    expect(tools).not.toMatch(/(^|[\s;])(position|transform)\s*:/);
    // The keyboard covers the home indicator: no safe-area gap above it.
    expect(rule('.mv-compose[data-mv-keyboard] .mv-compose__tools')).toContain('padding-bottom: 0');
    // The cause of the sideways scroll was a field sized to its longest option: the From chip
    // takes the line's remaining width and cuts a long address short.
    const chip = rule('.mv-compose__from-chip');
    expect(chip).toMatch(/(^|[\s;])flex: 1[;\s]/);
    expect(chip).toContain('min-width: 0');
    expect(rule('.mv-compose__scroll')).not.toContain('overflow-x');
  });
});
