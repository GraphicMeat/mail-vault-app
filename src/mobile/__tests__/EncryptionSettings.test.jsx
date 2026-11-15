// @vitest-environment jsdom
// Settings > Privacy & security > Encryption: the OpenPGP keys the engine decrypts with, listed,
// imported (pasted, or a picked file whose handle goes straight to the engine) and removed.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], keys: [], picks: [] }));
const KEY = { fingerprint: 'ABCD1234EF567890ABCD1234EF567890ABCD1234', userIds: ['Bob <bob@x.test>'], created: 1_700_000_000 };

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.pgp.listKeys':
        return { keys: engine.keys };
      case 'mobile.pgp.importKey':
        if (params.passphrase === 'wrong') throw Object.assign(new Error('The passphrase does not unlock this key'), { code: 'INVALID' });
        engine.keys = [KEY];
        return { keys: engine.keys };
      case 'mobile.pgp.removeKey':
        engine.keys = engine.keys.filter((k) => k.fingerprint !== params.fingerprint);
        return { keys: engine.keys };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  pickFiles: vi.fn(async () => engine.picks),
  listen: vi.fn(() => () => {}),
}));

const { default: EncryptionSettings } = await import('../EncryptionSettings.jsx');

beforeEach(() => { engine.calls = []; engine.keys = []; engine.picks = []; });
afterEach(cleanup);

const imports = () => engine.calls.filter(([m]) => m === 'mobile.pgp.importKey').map(([, p]) => p);

describe('Settings > Encryption', () => {
  it('imports a pasted key with its passphrase, lists it, and clears the fields', async () => {
    render(<EncryptionSettings />);
    await waitFor(() => expect(document.querySelector('[data-mv-pgp-none]')).toBeTruthy());
    expect(screen.getByText(t('pgp.decryptOnly'))).toBeTruthy();
    const importBtn = document.querySelector('[data-mv-pgp-import]');
    expect(importBtn.disabled).toBe(true);

    const pass = screen.getByLabelText(t('pgp.passphraseLabel'));
    const key = screen.getByLabelText(t('pgp.keyLabel'));
    fireEvent.change(pass, { target: { value: 'pw' } });
    fireEvent.change(key, { target: { value: '-----BEGIN PGP PRIVATE KEY BLOCK-----' } });
    fireEvent.click(importBtn);

    await waitFor(() => expect(document.querySelector('[data-mv-pgp-key]')).toBeTruthy());
    expect(imports()).toEqual([{ armored: '-----BEGIN PGP PRIVATE KEY BLOCK-----', passphrase: 'pw' }]);
    expect(screen.getByText('Bob <bob@x.test>')).toBeTruthy();
    expect(screen.getByText('ABCD 1234 EF56 7890 ABCD 1234 EF56 7890 ABCD 1234')).toBeTruthy();
    expect(key.value).toBe('');
    expect(pass.value).toBe('');
  });

  it('shows the engine\'s reason when the passphrase is wrong, and keeps the fields', async () => {
    render(<EncryptionSettings />);
    await waitFor(() => expect(document.querySelector('[data-mv-pgp-none]')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(t('pgp.passphraseLabel')), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText(t('pgp.keyLabel')), { target: { value: 'key' } });
    fireEvent.click(document.querySelector('[data-mv-pgp-import]'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(t('pgp.failed', { err: 'The passphrase does not unlock this key' }));
    expect(screen.getByLabelText(t('pgp.keyLabel')).value).toBe('key');
  });

  it('hands a picked key file to the engine by its handle only', async () => {
    engine.picks = [{ handle: 'out/ab/key.asc', name: 'key.asc', size: 900, mime: 'application/pgp-keys' }];
    render(<EncryptionSettings />);
    await waitFor(() => expect(document.querySelector('[data-mv-pgp-none]')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(t('pgp.passphraseLabel')), { target: { value: 'pw' } });
    fireEvent.click(document.querySelector('[data-mv-pgp-file]'));
    await waitFor(() => expect(document.querySelector('[data-mv-pgp-key]')).toBeTruthy());
    expect(imports()).toEqual([{ handle: 'out/ab/key.asc', passphrase: 'pw' }]);
  });

  it('a cancelled pick imports nothing', async () => {
    render(<EncryptionSettings />);
    await waitFor(() => expect(document.querySelector('[data-mv-pgp-none]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-mv-pgp-file]'));
    await new Promise((r) => setTimeout(r, 20));
    expect(imports()).toEqual([]);
  });

  it('removes a key', async () => {
    engine.keys = [KEY];
    render(<EncryptionSettings />);
    const remove = await screen.findByRole('button', { name: `${t('pgp.removeKey')}: ABCD 1234 EF56 7890 ABCD 1234 EF56 7890 ABCD 1234` });
    fireEvent.click(remove);
    await waitFor(() => expect(document.querySelector('[data-mv-pgp-none]')).toBeTruthy());
    expect(engine.calls.at(-1)).toEqual(['mobile.pgp.removeKey', { fingerprint: KEY.fingerprint }]);
  });
});
