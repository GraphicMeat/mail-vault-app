// @vitest-environment jsdom
// Compose over a fake engine: the From picker (the login, `sendAs` and the account's aliases),
// templates inserted into the body, and the attachment reminder before a send.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], settings: null, draft: null, prepare: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.accountSettings.get':
        return { ...engine.settings };
      case 'mobile.compose.send':
        return { id: 'out_1', state: 'queued' };
      case 'mobile.compose.prepare':
        return engine.prepare;
      case 'mobile.drafts.save':
        return { id: params.id || 'drf_0123456789abcdef' };
      case 'mobile.drafts.get':
        return engine.draft;
      case 'mobile.drafts.delete':
        return { deleted: true };
      case 'mobile.outbox.list':
        return [];
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  pickFiles: vi.fn(async () => [{ handle: 'out/0123456789abcdef/a.pdf', name: 'a.pdf', size: 10, mime: 'application/pdf' }]),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { default: Compose } = await import('../Compose.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const body = () => screen.getByLabelText(t('mobile.compose.body'));
const sendButton = () => screen.getByRole('button', { name: t('compose.send') });
const type = (el, value) => fireEvent.change(el, { target: { value } });

async function renderCompose(props = {}) {
  const onClose = vi.fn();
  render(<Compose accountId="a1" fromEmail="ada@example.test" mode="new" onClose={onClose} {...props} />);
  await flush();
  return { onClose };
}

async function addressed() {
  const to = screen.getByLabelText(t('common.to'));
  type(to, 'bob@example.test');
  await flush();
}

beforeEach(() => {
  engine.calls = [];
  engine.draft = null;
  engine.prepare = null;
  engine.settings = { accountId: 'a1', displayName: 'Ada', signature: null, sendAs: '', aliases: [] };
  useMobileStore.setState({
    prefs: PREF_DEFAULTS,
    accounts: [{ id: 'a1', email: 'ada@example.test', displayName: 'Ada', kind: 'imap' }],
  });
});
afterEach(cleanup);

describe('From', () => {
  it('is plain text for an account with one address, and sends no From', async () => {
    await renderCompose();
    expect(screen.queryByRole('combobox', { name: t('common.from') })).toBeNull();
    await addressed();
    await act(async () => { fireEvent.click(sendButton()); });
    await flush();
    expect(callsOf('mobile.compose.send')[0]).not.toHaveProperty('from');
  });

  it('starts from sendAs, offers every address, and sends the one picked', async () => {
    engine.settings.aliases = [{ address: 'hi@example.test', name: 'Ada Hi' }, { address: 'me@example.test', name: '' }];
    engine.settings.sendAs = 'me@example.test';
    await renderCompose();
    const pick = screen.getByRole('combobox', { name: t('common.from') });
    expect(pick.value).toBe('me@example.test');
    expect([...pick.options].map((o) => o.value)).toEqual(['ada@example.test', 'hi@example.test', 'me@example.test']);
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Ada <ada@example.test>', 'Ada Hi <hi@example.test>', 'me@example.test']);
    fireEvent.change(pick, { target: { value: 'hi@example.test' } });
    await addressed();
    await act(async () => { fireEvent.click(sendButton()); });
    await flush();
    expect(callsOf('mobile.compose.send')[0].from).toBe('hi@example.test');
  });

  it('a draft keeps the From it was written from', async () => {
    engine.settings.aliases = [{ address: 'hi@example.test', name: '' }];
    engine.draft = { id: 'drf_0123456789abcdef', accountId: 'a1', to: 'bob@example.test', cc: '', bcc: '', subject: 's', text: 'x', attachments: [], from: 'hi@example.test' };
    await renderCompose({ draftId: 'drf_0123456789abcdef' });
    await flush();
    expect(screen.getByRole('combobox', { name: t('common.from') }).value).toBe('hi@example.test');
    type(body(), 'x y');
    await act(async () => { fireEvent.click(sendButton()); });
    await flush();
    expect(callsOf('mobile.compose.send')[0].from).toBe('hi@example.test');
  });
});

describe('templates', () => {
  it('inserts a template at the top of the body', async () => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, templates: [{ name: 'Thanks', body: 'Thank you!' }, { name: 'Later', body: 'Talk later.' }] } });
    engine.settings.signature = { text: 'Ada', html: '', enabled: true };
    await renderCompose();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: t('compose.templates') }));
    fireEvent.click(screen.getByRole('button', { name: 'Thanks' }));
    expect(body().value).toBe('Thank you!\n\n-- \nAda');
  });

  it('is not offered when there are no templates', async () => {
    await renderCompose();
    expect(screen.queryByRole('button', { name: t('compose.templates') })).toBeNull();
  });
});

describe('attachment reminder', () => {
  it('asks before sending a message that mentions an attachment and has none', async () => {
    await renderCompose();
    await addressed();
    type(body(), 'The report is attached.');
    await act(async () => { fireEvent.click(sendButton()); });
    await flush();
    expect(callsOf('mobile.compose.send')).toEqual([]);
    expect(screen.getByText(t('compose.attachmentReminder.title'))).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('compose.attachmentReminder.sendAnyway') })); });
    await flush();
    expect(callsOf('mobile.compose.send')).toHaveLength(1);
  });

  it('Attach file opens the picker instead of sending', async () => {
    await renderCompose();
    await addressed();
    type(body(), 'See the attachment');
    await act(async () => { fireEvent.click(sendButton()); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('compose.attachmentReminder.attach') })); });
    await flush();
    expect(callsOf('mobile.compose.send')).toEqual([]);
    expect(screen.getByRole('button', { name: t('mobile.compose.pickFiles') })).toBeTruthy();
  });

  it('stays quiet when something is attached, when it is off, and for words only in the quote', async () => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, attachmentReminder: false } });
    await renderCompose();
    await addressed();
    type(body(), 'attached');
    await act(async () => { fireEvent.click(sendButton()); });
    await flush();
    expect(callsOf('mobile.compose.send')).toHaveLength(1);
    cleanup();

    useMobileStore.setState({ prefs: PREF_DEFAULTS });
    engine.prepare = {
      to: 'bob@example.test', cc: '', subject: 'Re: attachment', quote: '', quoteText: 'Original message\nFrom: Bob\nSubject: attachment\n\n> the attachment\n',
      quotePending: false, inReplyTo: '<x@y>', references: '<x@y>', attachments: [], pending: [],
    };
    await renderCompose({ mode: 'reply', original: { folder: 'INBOX', uid: 1 } });
    await flush();
    await act(async () => { fireEvent.click(sendButton()); });
    await flush();
    expect(callsOf('mobile.compose.send')).toHaveLength(2);
  });

  it('asks before Send later too', async () => {
    await renderCompose();
    await addressed();
    type(body(), 'enclosed');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.sendLater') })); });
    await flush();
    expect(screen.getByText(t('compose.attachmentReminder.title'))).toBeTruthy();
  });
});
