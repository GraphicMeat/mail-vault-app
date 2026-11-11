// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { t } from '../../../i18n';

const transfer = vi.hoisted(() => ({ phoneQr: vi.fn() }));
vi.mock('../../../services/workflows/transferAccounts', () => transfer);

import { PhoneQrModal, PHONE_QR_FRAME_MS, PHONE_QR_HIDE_MS } from '../PhoneQrModal';

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const both = value => { type(t('settings.transfer.password'), value); type(t('settings.transfer.confirmPassword'), value); };
const showButton = () => screen.getByRole('button', { name: t('settings.phoneSetup.generate') });
const qr = () => screen.queryByRole('img', { name: t('settings.phoneSetup.qrAlt') });
const svg = n => `<svg xmlns="http://www.w3.org/2000/svg"><title>frame ${n}</title></svg>`;
const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

async function generate(reply) {
  transfer.phoneQr.mockResolvedValue(reply);
  both('correct horse battery');
  await act(async () => { fireEvent.click(showButton()); });
  await act(async () => {});
}

it('enables Show only for a matching password of at least 12 characters', () => {
  render(<PhoneQrModal onClose={() => {}} />);
  expect(showButton().disabled).toBe(true);
  both('12345678901');
  expect(showButton().disabled).toBe(true);
  type(t('settings.transfer.password'), '123456789012');
  type(t('settings.transfer.confirmPassword'), '123456789013');
  expect(showButton().disabled).toBe(true);
  expect(screen.getByText(t('settings.transfer.passwordMismatch'))).toBeTruthy();
  type(t('settings.transfer.confirmPassword'), '123456789012');
  expect(showButton().disabled).toBe(false);
});

it('shows one frame as an image with the steps, and drops the password', async () => {
  render(<PhoneQrModal onClose={() => {}} />);
  await generate({ frames: [svg(1)], count: 1, skipped: [] });
  expect(transfer.phoneQr).toHaveBeenCalledWith({ password: 'correct horse battery' });
  const img = qr();
  expect(img).toBeTruthy();
  expect(img.getAttribute('src')).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg(1))}`);
  expect(screen.queryByText(t('settings.phoneSetup.part', { index: 1, total: 1 }))).toBeNull();
  expect(screen.getByText(t('settings.phoneSetup.step1'))).toBeTruthy();
  expect(screen.getByText(t('settings.phoneSetup.step2'))).toBeTruthy();
  expect(screen.getByText(t('settings.phoneSetup.step3'))).toBeTruthy();
  expect(screen.queryByLabelText(t('settings.transfer.password'))).toBeNull();
});

it('cycles several frames with a part caption, off the phone camera\'s one-second rhythm', async () => {
  fake();
  render(<PhoneQrModal onClose={() => {}} />);
  await generate({ frames: [svg(1), svg(2), svg(3)], count: 3, skipped: [] });
  expect(PHONE_QR_FRAME_MS).toBe(700);
  expect(screen.getByText(t('settings.phoneSetup.part', { index: 1, total: 3 }))).toBeTruthy();
  expect(qr().getAttribute('src')).toContain(encodeURIComponent('frame 1'));
  act(() => { vi.advanceTimersByTime(PHONE_QR_FRAME_MS); });
  expect(screen.getByText(t('settings.phoneSetup.part', { index: 2, total: 3 }))).toBeTruthy();
  expect(qr().getAttribute('src')).toContain(encodeURIComponent('frame 2'));
  act(() => { vi.advanceTimersByTime(2 * PHONE_QR_FRAME_MS); });
  expect(screen.getByText(t('settings.phoneSetup.part', { index: 1, total: 3 }))).toBeTruthy();
});

it('hides the code after five minutes and asks for a password again', async () => {
  fake();
  render(<PhoneQrModal onClose={() => {}} />);
  await generate({ frames: [svg(1), svg(2)], count: 2, skipped: [] });
  expect(PHONE_QR_HIDE_MS).toBe(5 * 60 * 1000);
  act(() => { vi.advanceTimersByTime(PHONE_QR_HIDE_MS - 1); });
  expect(qr()).toBeTruthy();
  act(() => { vi.advanceTimersByTime(1); });
  expect(qr()).toBeNull();
  expect(screen.getByText(t('settings.phoneSetup.hidden'))).toBeTruthy();
  expect(screen.getByLabelText(t('settings.transfer.password')).value).toBe('');
});

it('clears its timers when closed', async () => {
  fake();
  const { unmount } = render(<PhoneQrModal onClose={() => {}} />);
  await generate({ frames: [svg(1), svg(2)], count: 2, skipped: [] });
  // the cycle and the five-minute hide are both cleared, so neither fires on an unmounted modal
  const intervals = vi.spyOn(globalThis, 'clearInterval');
  const timeouts = vi.spyOn(globalThis, 'clearTimeout');
  unmount();
  expect(intervals).toHaveBeenCalled();
  expect(timeouts).toHaveBeenCalled();
});

it('names the accounts left out and why', async () => {
  render(<PhoneQrModal onClose={() => {}} />);
  await generate({ frames: [svg(1)], count: 1, skipped: [
    { email: 'locked@x.test', reason: 'no-secret' },
    { email: 'own@x.test', reason: 'custom-oauth-client' },
    { email: 'yahoo@x.test', reason: 'unsupported-provider' },
    { email: 'login@x.test', reason: 'jmap-login' },
    { email: 'odd@x.test', reason: 'invalid' },
  ] });
  expect(screen.getByText(t('settings.phoneSetup.skippedTitle'))).toBeTruthy();
  for (const email of ['locked@x.test', 'own@x.test', 'yahoo@x.test', 'login@x.test', 'odd@x.test']) {
    expect(screen.getByText(email)).toBeTruthy();
  }
  for (const key of ['noSecret', 'customOauthClient', 'unsupportedProvider', 'jmapLogin', 'invalid']) {
    expect(screen.getByText(t(`settings.phoneSetup.skip.${key}`))).toBeTruthy();
  }
});

it('says so when no account can go to the phone', async () => {
  render(<PhoneQrModal onClose={() => {}} />);
  await generate({ frames: [], count: 0, skipped: [{ email: 'locked@x.test', reason: 'no-secret' }] });
  expect(qr()).toBeNull();
  expect(screen.getByText(t('settings.phoneSetup.nothing'))).toBeTruthy();
  expect(screen.getByText('locked@x.test')).toBeTruthy();
});

it('shows a daemon or keychain failure as its catalog message', async () => {
  transfer.phoneQr.mockRejectedValue(new Error('E_KEYCHAIN_UNAVAILABLE'));
  render(<PhoneQrModal onClose={() => {}} />);
  both('correct horse battery');
  await act(async () => { fireEvent.click(showButton()); });
  expect((await screen.findByRole('alert')).textContent).toBe(t('settings.transfer.errors.keychain'));
  expect(qr()).toBeNull();
});

it('closes through its button', async () => {
  const onClose = vi.fn();
  render(<PhoneQrModal onClose={onClose} />);
  await generate({ frames: [svg(1)], count: 1, skipped: [] });
  fireEvent.click(screen.getAllByRole('button', { name: t('common.close') }).at(-1));
  expect(onClose).toHaveBeenCalled();
});
