// @vitest-environment jsdom
//
// Settings > Encryption: lists, imports and removes OpenPGP secret keys
// through the daemon's `pgp.*` RPCs (mocked here at services/api).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const api = {
  pgpListKeys: vi.fn(),
  pgpImportKey: vi.fn(),
  pgpRemoveKey: vi.fn(),
};
vi.mock('../../../services/api', () => ({
  pgpListKeys: (...a) => api.pgpListKeys(...a),
  pgpImportKey: (...a) => api.pgpImportKey(...a),
  pgpRemoveKey: (...a) => api.pgpRemoveKey(...a),
}));

const { EncryptionSettings } = await import('../EncryptionSettings');

const KEY = { fingerprint: 'ABCD1234EF567890ABCD1234EF567890ABCD1234', userIds: ['Bob <bob@x.test>'], created: 1_700_000_000 };
const ARMORED = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nxVgE\n-----END PGP PRIVATE KEY BLOCK-----';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.pgpListKeys.mockResolvedValue({ keys: [] });
});
afterEach(cleanup);

describe('EncryptionSettings', () => {
  it('lists no keys, then the imported one, sending the pasted key and passphrase', async () => {
    api.pgpImportKey.mockResolvedValue({ keys: [KEY] });
    render(<EncryptionSettings />);
    expect(await screen.findByTestId('pgp-no-keys')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: ARMORED } });
    fireEvent.change(document.querySelector('input[type="password"]'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import key' }));

    const row = await screen.findByTestId('pgp-key-row');
    expect(api.pgpImportKey).toHaveBeenCalledWith(ARMORED, 'pw');
    expect(row.textContent).toContain('Bob <bob@x.test>');
    expect(row.textContent).toContain('ABCD 1234 EF56');
    // The form clears once the key is in the keychain.
    expect(screen.getByRole('textbox').value).toBe('');
    expect(document.querySelector('input[type="password"]').value).toBe('');
  });

  it('removes a key by its fingerprint', async () => {
    api.pgpListKeys.mockResolvedValue({ keys: [KEY] });
    api.pgpRemoveKey.mockResolvedValue({ keys: [] });
    render(<EncryptionSettings />);
    await screen.findByTestId('pgp-key-row');
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    await screen.findByTestId('pgp-no-keys');
    expect(api.pgpRemoveKey).toHaveBeenCalledWith(KEY.fingerprint);
  });

  it('shows why an import was refused and keeps what was typed', async () => {
    api.pgpImportKey.mockRejectedValue(new Error('The passphrase does not unlock this key'));
    render(<EncryptionSettings />);
    await screen.findByTestId('pgp-no-keys');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ARMORED } });
    fireEvent.click(screen.getByRole('button', { name: 'Import key' }));
    expect((await screen.findByRole('alert')).textContent).toContain('does not unlock');
    expect(screen.getByRole('textbox').value).toBe(ARMORED);
  });

  it('reads a picked key file into the form', async () => {
    render(<EncryptionSettings />);
    await screen.findByTestId('pgp-no-keys');
    const file = new File([ARMORED], 'bob.asc', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('pgp-file-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('textbox').value).toBe(ARMORED));
  });

  it('cannot import an empty key', async () => {
    render(<EncryptionSettings />);
    await screen.findByTestId('pgp-no-keys');
    expect(screen.getByRole('button', { name: 'Import key' }).disabled).toBe(true);
  });
});
