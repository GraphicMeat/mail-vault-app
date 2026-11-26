// @vitest-environment jsdom
// Compose's From over several accounts: the chip opens a sheet of every account with its aliases
// indented; picking another account re-homes the compose (account, signature, draft) and keeps the
// typed text, the recipients and the attachments.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { t } from '../i18n.js';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));

const DRAFT_ID = 'drf_0123456789abcdef';
const engine = vi.hoisted(() => ({ calls: [], settings: {}, draft: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.accountSettings.get':
        return { ...engine.settings[params.accountId] };
      case 'mobile.compose.send':
        return { id: 'out_1', state: 'queued' };
      case 'mobile.drafts.save':
        return { id: params.id || DRAFT_ID };
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
const chip = () => document.querySelector('[data-mv-from-chip]');
const choice = (address) => document.querySelector(`[data-mv-from-choice="${address}"]`);
const sig = (text) => ({ enabled: true, text });

async function renderCompose(props = {}) {
  render(<Compose accountId="a1" fromEmail="ada@example.test" mode="new" onClose={vi.fn()} {...props} />);
  await flush();
}
async function openSheet() {
  await act(async () => { fireEvent.click(chip()); });
  await flush();
}
async function pick(address) {
  await openSheet();
  fireEvent.click(choice(address));
  await flush();
}

beforeEach(() => {
  engine.calls = [];
  engine.draft = null;
  engine.settings = {
    a1: { accountId: 'a1', displayName: 'Ada', signature: sig('Ada sig'), sendAs: '', aliases: [] },
    a2: { accountId: 'a2', displayName: 'Grace', signature: sig('Grace sig'), sendAs: '', aliases: [{ address: 'g2@example.test', name: 'Grace Two' }] },
    a3: { accountId: 'a3', displayName: 'Hopper', signature: null, sendAs: '', aliases: [] },
  };
  for (const f of Object.values(haptic)) f.mockClear();
  useMobileStore.setState({
    prefs: PREF_DEFAULTS,
    premium: { premium: true, source: 'apple', expiresMs: Date.now() + 86_400_000 },
    accounts: [
      { id: 'a1', email: 'ada@example.test', displayName: 'Ada', kind: 'imap' },
      { id: 'a2', email: 'grace@example.test', displayName: 'Grace', kind: 'imap' },
      { id: 'a3', email: 'hopper@example.test', displayName: 'Hopper', kind: 'graph' },
    ],
  });
});
afterEach(() => {
  cleanup();
  useMobileStore.setState({ accounts: [], premium: { premium: false, source: null, expiresMs: null } });
});

describe('From over several accounts', () => {
  it('shows a chip with the account\'s avatar, address and a chevron, even for an account with no aliases', async () => {
    await renderCompose();
    expect(chip().textContent).toContain('ada@example.test');
    expect(chip().querySelector('.mv-avatar')).toBeTruthy();
    expect(chip().querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(chip().getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('the sheet lists every account (avatar, address, name) with its aliases indented under it', async () => {
    await renderCompose();
    await openSheet();
    const sheet = screen.getByRole('dialog', { name: t('mobile.compose.fromTitle') });
    const rows = [...sheet.querySelectorAll('[data-mv-from-choice]')];
    expect(rows.map((r) => r.getAttribute('data-mv-from-choice'))).toEqual([
      'ada@example.test', 'grace@example.test', 'g2@example.test', 'hopper@example.test',
    ]);
    expect(rows.map((r) => r.hasAttribute('data-mv-from-alias'))).toEqual([false, false, true, false]);
    const grace = within(sheet).getByText('grace@example.test').closest('[data-mv-from-choice]');
    expect(grace.querySelector('.mv-avatar')).toBeTruthy();
    expect(grace.textContent).toContain('Grace');
    expect(choice('g2@example.test').textContent).toContain('Grace Two');
    expect(choice('ada@example.test').getAttribute('aria-checked')).toBe('true');
    expect(choice('grace@example.test').getAttribute('aria-checked')).toBe('false');
  });

  it('picking another account re-homes the compose: account, signature, and the typed text, recipients and attachments stay', async () => {
    await renderCompose();
    expect(body().value).toBe('\n\n-- \nAda sig');
    type(screen.getByLabelText(t('common.to')), 'bob@example.test');
    type(screen.getByLabelText(t('compose.subject')), 'Plan');
    type(body(), 'Hello there\n\n-- \nAda sig');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.attach') })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.pickFiles') })); });
    await flush();
    await pick('grace@example.test');
    expect(haptic.selection).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: t('mobile.compose.fromTitle') })).toBeNull();
    expect(chip().textContent).toContain('grace@example.test');
    expect(body().value).toBe('Hello there\n\n-- \nGrace sig');
    expect(screen.getByLabelText(t('compose.subject')).value).toBe('Plan');
    expect(screen.getByText('a.pdf')).toBeTruthy();
    await act(async () => { fireEvent.click(sendButton()); });
    await flush();
    const [sent] = callsOf('mobile.compose.send');
    expect(sent).toMatchObject({ accountId: 'a2', to: 'bob@example.test', subject: 'Plan', text: 'Hello there\n\n-- \nGrace sig', from: 'grace@example.test' });
    expect(sent.attachments).toEqual([{ handle: 'out/0123456789abcdef/a.pdf' }]);
  });

  it('picking an alias of another account sends from that alias on that account', async () => {
    await renderCompose();
    type(screen.getByLabelText(t('common.to')), 'bob@example.test');
    await pick('g2@example.test');
    await act(async () => { fireEvent.click(sendButton()); });
    await flush();
    expect(callsOf('mobile.compose.send')[0]).toMatchObject({ accountId: 'a2', from: 'g2@example.test' });
  });

  it('a pick within the same account only changes the address', async () => {
    engine.settings.a1.aliases = [{ address: 'hi@example.test', name: '' }];
    await renderCompose();
    type(screen.getByLabelText(t('common.to')), 'bob@example.test');
    await pick('hi@example.test');
    expect(body().value).toBe('\n\n-- \nAda sig');
    await act(async () => { fireEvent.click(sendButton()); });
    await flush();
    expect(callsOf('mobile.compose.send')[0]).toMatchObject({ accountId: 'a1', from: 'hi@example.test' });
  });

  it('a saved draft moves to the new account under the same draft id', async () => {
    engine.draft = { id: DRAFT_ID, accountId: 'a1', to: 'bob@example.test', cc: '', bcc: '', subject: 's', text: 'Draft body', attachments: [] };
    await renderCompose({ draftId: DRAFT_ID });
    await flush();
    await pick('grace@example.test');
    // A reopened draft has its own text: no signature is added to it.
    expect(body().value).toBe('Draft body');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.back') })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('mobile.compose.saveDraft') })); });
    await flush();
    const saves = callsOf('mobile.drafts.save');
    expect(saves.at(-1)).toMatchObject({ id: DRAFT_ID, accountId: 'a2', to: 'bob@example.test', text: 'Draft body' });
  });

  it('moving to a Graph account drops a follow-up reminder it cannot offer', async () => {
    await renderCompose();
    fireEvent.click(document.querySelector('[data-mv-followup-open]'));
    fireEvent.click(document.querySelector('[data-mv-remind-choice="3"]'));
    expect(document.querySelector('[data-mv-followup-chip]')).toBeTruthy();
    await pick('hopper@example.test');
    expect(document.querySelector('[data-mv-followup-chip]')).toBeNull();
    expect(document.querySelector('[data-mv-followup-open]')).toBeNull();
  });
});
