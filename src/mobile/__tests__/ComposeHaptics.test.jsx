// @vitest-environment jsdom
// Compose ticks when a send goes out (success) and when it is refused (error).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { t } from '../i18n.js';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));

const engine = vi.hoisted(() => ({ fail: false }));
vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    switch (method) {
      case 'mobile.accountSettings.get':
        return { accountId: 'a1', displayName: 'Ada', signature: null, sendAs: '', aliases: [] };
      case 'mobile.compose.send':
        if (engine.fail) throw Object.assign(new Error('refused'), { code: 'INTERNAL' });
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

async function sendOne() {
  render(<Compose accountId="a1" fromEmail="ada@example.test" mode="new" onClose={vi.fn()} />);
  await flush();
  fireEvent.change(screen.getByLabelText(t('common.to')), { target: { value: 'bob@example.test' } });
  await flush();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('compose.send') })); });
  await flush();
}

beforeEach(() => {
  engine.fail = false;
  for (const f of Object.values(haptic)) f.mockClear();
  useMobileStore.setState({ prefs: PREF_DEFAULTS, accounts: [{ id: 'a1', email: 'ada@example.test', displayName: 'Ada', kind: 'imap' }] });
});
afterEach(cleanup);

describe('Compose haptics', () => {
  it('a send that goes out is a success notification', async () => {
    await sendOne();
    expect(haptic.notify).toHaveBeenCalledTimes(1);
    expect(haptic.notify).toHaveBeenCalledWith('success');
  });

  it('a send that is refused is an error notification', async () => {
    engine.fail = true;
    await sendOne();
    expect(haptic.notify).toHaveBeenCalledTimes(1);
    expect(haptic.notify).toHaveBeenCalledWith('error');
  });
});
