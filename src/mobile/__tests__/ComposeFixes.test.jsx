// @vitest-environment jsdom
// Fix wave for Compose: a From pick made before the account's reads come back never leaves another
// account's signature in the message, and every toolbar button draws its icon at one size.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { t } from '../i18n.js';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));

const engine = vi.hoisted(() => ({ calls: [], settings: {}, gate: {}, prepare: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.accountSettings.get':
        if (engine.gate[params.accountId]) await engine.gate[params.accountId];
        return { ...engine.settings[params.accountId] };
      case 'mobile.compose.prepare':
        return engine.prepare(params);
      case 'mobile.compose.send':
        return { id: 'out_1', state: 'queued' };
      case 'mobile.drafts.save':
        return { id: params.id || 'drf_0123456789abcdef' };
      case 'mobile.drafts.delete':
        return { deleted: true };
      case 'mobile.outbox.list':
        return [];
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  pickFiles: vi.fn(async () => []),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { default: Compose } = await import('../Compose.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const body = () => screen.getByLabelText(t('mobile.compose.body'));
const chip = () => document.querySelector('[data-mv-from-chip]');
const choice = (address) => document.querySelector(`[data-mv-from-choice="${address}"]`);
const sig = (text) => ({ enabled: true, text });
const defer = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };

async function renderCompose(props = {}) {
  render(<Compose accountId="a1" fromEmail="ada@example.test" mode="new" onClose={vi.fn()} {...props} />);
  await flush();
}
async function pick(address) {
  await act(async () => { fireEvent.click(chip()); });
  await flush();
  fireEvent.click(choice(address));
  await flush();
}

beforeEach(() => {
  engine.calls = [];
  engine.gate = {};
  engine.prepare = null;
  engine.settings = {
    a1: { accountId: 'a1', displayName: 'Ada', signature: sig('Ada sig'), sendAs: '', aliases: [] },
    a2: { accountId: 'a2', displayName: 'Grace', signature: sig('Grace sig'), sendAs: '', aliases: [] },
    a3: { accountId: 'a3', displayName: 'Hopper', signature: null, sendAs: '', aliases: [] },
  };
  useMobileStore.setState({
    prefs: PREF_DEFAULTS,
    premium: { premium: true, source: 'apple', expiresMs: Date.now() + 86_400_000 },
    accounts: [
      { id: 'a1', email: 'ada@example.test', displayName: 'Ada', kind: 'imap' },
      { id: 'a2', email: 'grace@example.test', displayName: 'Grace', kind: 'imap' },
      { id: 'a3', email: 'hopper@example.test', displayName: 'Hopper', kind: 'imap' },
    ],
  });
});
afterEach(() => {
  cleanup();
  useMobileStore.setState({ accounts: [], premium: { premium: false, source: null, expiresMs: null } });
});

describe('a From pick racing the first reads', () => {
  it('a reply prepared after the pick carries the new account\'s signature, not the first account\'s', async () => {
    const gate = defer();
    engine.prepare = () => gate.p;
    await renderCompose({ mode: 'reply', original: { folder: 'INBOX', uid: 1, dateMs: 1000 } });
    await pick('grace@example.test');
    await act(async () => {
      gate.release({ to: 'bob@example.test', cc: '', subject: 'Re: Plans', quote: '', quoteText: '> hi', inReplyTo: '', references: '', attachments: [], pending: [] });
    });
    await flush();
    expect(body().value).toContain('Grace sig');
    expect(body().value).not.toContain('Ada sig');
    expect(body().value).toContain('> hi');
  });

  it('a new message whose first account answers late keeps the picked account\'s signature, and a later pick swaps it', async () => {
    const gate = defer();
    engine.gate.a1 = gate.p;
    await renderCompose();
    await pick('grace@example.test');
    expect(body().value).toContain('Grace sig');
    await act(async () => { gate.release(); });
    await flush();
    expect(body().value).toContain('Grace sig');
    expect(body().value).not.toContain('Ada sig');
    // The signature on the screen is Grace's, so moving to an account with none removes it.
    await pick('hopper@example.test');
    expect(body().value).not.toContain('Grace sig');
    expect(body().value).not.toContain('Ada sig');
  });
});

describe('the toolbar', () => {
  it('draws every icon at one size, so the captions line up', async () => {
    await renderCompose();
    const buttons = [...screen.getByRole('toolbar').querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    expect(buttons.some((b) => b.hasAttribute('data-mv-followup-open'))).toBe(true);
    const sizes = buttons.map((b) => b.querySelector('svg').getAttribute('width'));
    expect(new Set(sizes).size).toBe(1);
    const captions = buttons.map((b) => b.querySelector('.mv-compose__tool-caption'));
    expect(captions.every((c) => c && c.parentElement.firstElementChild.tagName.toLowerCase() === 'svg')).toBe(true);
  });
});
