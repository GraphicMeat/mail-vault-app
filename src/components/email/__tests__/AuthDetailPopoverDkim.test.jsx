// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const daemonCall = vi.fn();
vi.mock('../../../services/daemonClient', () => ({ daemonCall: (...a) => daemonCall(...a) }));

import { AuthDetailPopover, _resetDkimKeyLookups } from '../EmailHeaderComponent';

const base = {
  from: { name: 'Erikas from Kaching Appz', address: 'team@kachingappz.com' },
  authenticationResults: 'mx.test; spf=pass; dkim=pass header.d=kachingappz.com; dmarc=pass',
  dkimSignature: 'a=rsa-sha256; d=kachingappz.com; s=k1',
};

const dkimRow = (container) =>
  [...container.querySelectorAll('div')].find(d => d.textContent.startsWith('DKIM') && d.children.length >= 3);
const open = (email) => render(<AuthDetailPopover email={email} onClose={() => {}} />);

beforeEach(() => {
  _resetDkimKeyLookups();
  daemonCall.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AuthDetailPopover DKIM row', () => {
  it('shows the signing algorithm at once and the key type and size when the lookup answers', async () => {
    daemonCall.mockResolvedValue({ key: { keyType: 'rsa', bits: 2048, revoked: false } });
    const { container } = open(base);
    expect(dkimRow(container).textContent).toContain('rsa-sha256');
    await waitFor(() => expect(dkimRow(container).textContent).toContain('RSA 2048-bit'));
    expect(daemonCall).toHaveBeenCalledWith('dkim_key', expect.objectContaining({ domain: 'kachingappz.com', selector: 'k1' }));
  });

  it('shows an older 1024-bit key as it is', async () => {
    daemonCall.mockResolvedValue({ key: { keyType: 'rsa', bits: 1024, revoked: false } });
    const { container } = open(base);
    await waitFor(() => expect(dkimRow(container).textContent).toContain('RSA 1024-bit'));
  });

  it('shows Ed25519 and Ed448 keys', async () => {
    daemonCall.mockResolvedValue({ key: { keyType: 'ed25519', bits: 256, revoked: false } });
    const first = open({ ...base, dkimSignature: 'a=ed25519-sha256; d=kachingappz.com; s=ed' });
    await waitFor(() => expect(dkimRow(first.container).textContent).toContain('Ed25519 256-bit'));
    cleanup();
    _resetDkimKeyLookups();
    daemonCall.mockResolvedValue({ key: { keyType: 'ed448', bits: 448, revoked: false } });
    const second = open({ ...base, dkimSignature: 'a=ed448-sha512; d=kachingappz.com; s=e4' });
    await waitFor(() => expect(dkimRow(second.container).textContent).toContain('Ed448 448-bit'));
  });

  it('asks once per domain and selector, however often the popover opens', async () => {
    daemonCall.mockResolvedValue({ key: { keyType: 'rsa', bits: 2048, revoked: false } });
    const a = open(base);
    await waitFor(() => expect(dkimRow(a.container).textContent).toContain('RSA 2048-bit'));
    cleanup();
    const b = open(base);
    await waitFor(() => expect(dkimRow(b.container).textContent).toContain('RSA 2048-bit'));
    expect(daemonCall).toHaveBeenCalledTimes(1);
  });

  it('keeps the algorithm and drops the key when the lookup finds none or fails', async () => {
    daemonCall.mockResolvedValue({ key: null });
    const { container } = open(base);
    await waitFor(() => expect(daemonCall).toHaveBeenCalled());
    expect(dkimRow(container).textContent).toContain('rsa-sha256');
    expect(dkimRow(container).textContent).not.toMatch(/-bit/);
    cleanup();
    _resetDkimKeyLookups();
    daemonCall.mockRejectedValue(new Error('offline'));
    const failed = open(base);
    await waitFor(() => expect(daemonCall).toHaveBeenCalledTimes(2));
    expect(dkimRow(failed.container).textContent).toContain('rsa-sha256');
  });

  it('does not look anything up for a message with no signature summary', () => {
    const { container } = open({ ...base, dkimSignature: undefined });
    expect(daemonCall).not.toHaveBeenCalled();
    expect(dkimRow(container).textContent).toMatch(/pass$/);
  });

  it('does not look anything up when DKIM did not pass', () => {
    open({ ...base, authenticationResults: 'mx.test; spf=pass; dkim=fail; dmarc=pass' });
    expect(daemonCall).not.toHaveBeenCalled();
  });
});
