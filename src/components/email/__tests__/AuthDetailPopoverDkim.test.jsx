// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { verdict } from '../../../test/senderVerdicts';

const daemonCall = vi.fn();
vi.mock('../../../services/daemonClient', () => ({ daemonCall: (...a) => daemonCall(...a) }));

import { AuthDetailPopover, formatDkimKey, _resetDkimKeyLookups } from '../EmailHeaderComponent';
import { _resetSenderVerdicts } from '../../../services/senderVerdict';

const base = {
  from: { name: 'Erikas from Kaching Appz', address: 'team@kachingappz.com' },
  authenticationResults: 'mx.test; spf=pass; dkim=pass header.d=kachingappz.com; dmarc=pass',
  dkimSignature: 'a=rsa-sha256; d=kachingappz.com; s=k1',
};

// The daemon's verdict (message.verify_sender) for these messages: the DKIM
// result and the signature's algorithm, domain and selector it reads.
function senderVerdict(p) {
  const tag = (t) => (p.dkimSignature || '').match(new RegExp(`\\b${t}=([^;\\s]+)`))?.[1] ?? null;
  const fromResults = (p.authenticationResults || '').match(/header\.d=([\w.-]+)/)?.[1] ?? null;
  const dkim = { algorithm: tag('a'), domain: tag('d') || fromResults, selector: tag('s') };
  const passed = /dkim=pass/.test(p.authenticationResults || '');
  return verdict({
    status: passed ? 'verified' : 'none',
    auth: { spf: 'pass', dkim: passed ? 'pass' : 'fail', dmarc: 'pass' },
    dkim: dkim.algorithm || dkim.domain || dkim.selector ? dkim : null,
  });
}

// `dkim_key` answers `key` (or fails with it, when it is an Error).
function keyAnswers(key) {
  daemonCall.mockImplementation(async (method, params) => {
    if (method === 'message.verify_sender') return senderVerdict(params);
    if (key instanceof Error) throw key;
    return { key };
  });
}
const keyLookups = () => daemonCall.mock.calls.filter(([method]) => method === 'dkim_key');

const dkimRow = (container) =>
  [...container.querySelectorAll('div')].find(d => d.textContent.startsWith('DKIM') && d.children.length >= 3);
const open = (email, given) => render(<AuthDetailPopover email={email} verdict={given} onClose={() => {}} />);

beforeEach(() => {
  _resetDkimKeyLookups();
  _resetSenderVerdicts();
  daemonCall.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AuthDetailPopover DKIM row', () => {
  it('shows the signing algorithm at once when handed the badge\'s verdict', () => {
    keyAnswers(null);
    const { container } = open(base, senderVerdict(base));
    expect(dkimRow(container).textContent).toContain('rsa-sha256');
    expect(daemonCall.mock.calls.some(([m]) => m === 'message.verify_sender')).toBe(false);
  });

  it('shows the signing algorithm and the key type and size when the lookup answers', async () => {
    keyAnswers({ keyType: 'rsa', bits: 2048, revoked: false });
    const { container } = open(base);
    await waitFor(() => expect(dkimRow(container).textContent).toContain('rsa-sha256'));
    await waitFor(() => expect(dkimRow(container).textContent).toContain('RSA 2048-bit'));
    expect(daemonCall).toHaveBeenCalledWith('dkim_key', expect.objectContaining({ domain: 'kachingappz.com', selector: 'k1' }));
  });

  it('shows an older 1024-bit key as it is', async () => {
    keyAnswers({ keyType: 'rsa', bits: 1024, revoked: false });
    const { container } = open(base);
    await waitFor(() => expect(dkimRow(container).textContent).toContain('RSA 1024-bit'));
  });

  it('shows Ed25519 and Ed448 keys', async () => {
    keyAnswers({ keyType: 'ed25519', bits: 256, revoked: false });
    const first = open({ ...base, dkimSignature: 'a=ed25519-sha256; d=kachingappz.com; s=ed' });
    await waitFor(() => expect(dkimRow(first.container).textContent).toContain('Ed25519 256-bit'));
    cleanup();
    _resetDkimKeyLookups();
    keyAnswers({ keyType: 'ed448', bits: 448, revoked: false });
    const second = open({ ...base, dkimSignature: 'a=ed448-sha512; d=kachingappz.com; s=e4' });
    await waitFor(() => expect(dkimRow(second.container).textContent).toContain('Ed448 448-bit'));
  });

  it('asks once per domain and selector, however often the popover opens', async () => {
    keyAnswers({ keyType: 'rsa', bits: 2048, revoked: false });
    const a = open(base);
    await waitFor(() => expect(dkimRow(a.container).textContent).toContain('RSA 2048-bit'));
    cleanup();
    const b = open(base);
    await waitFor(() => expect(dkimRow(b.container).textContent).toContain('RSA 2048-bit'));
    expect(keyLookups()).toHaveLength(1);
  });

  it('keeps the algorithm and drops the key when the lookup finds none or fails', async () => {
    keyAnswers(null);
    const { container } = open(base);
    await waitFor(() => expect(keyLookups()).toHaveLength(1));
    expect(dkimRow(container).textContent).toContain('rsa-sha256');
    expect(dkimRow(container).textContent).not.toMatch(/-bit/);
    cleanup();
    _resetDkimKeyLookups();
    keyAnswers(new Error('offline'));
    const failed = open(base);
    await waitFor(() => expect(keyLookups()).toHaveLength(2));
    expect(dkimRow(failed.container).textContent).toContain('rsa-sha256');
  });

  it('does not look anything up for a message with no signature summary', async () => {
    keyAnswers(null);
    const { container } = open({ ...base, dkimSignature: undefined });
    await waitFor(() => expect(dkimRow(container).textContent).toMatch(/pass$/));
    expect(keyLookups()).toHaveLength(0);
  });

  it('does not look anything up when DKIM did not pass', async () => {
    keyAnswers(null);
    const { container } = open({ ...base, authenticationResults: 'mx.test; spf=pass; dkim=fail; dmarc=pass' });
    await waitFor(() => expect(dkimRow(container).textContent).toContain('fail'));
    expect(keyLookups()).toHaveLength(0);
  });
});

describe('formatDkimKey', () => {
  it('names the key type and size', () => {
    expect(formatDkimKey({ keyType: 'rsa', bits: 1024, revoked: false })).toBe('RSA 1024-bit');
    expect(formatDkimKey({ keyType: 'rsa', bits: 2048, revoked: false })).toBe('RSA 2048-bit');
    expect(formatDkimKey({ keyType: 'ed25519', bits: 256, revoked: false })).toBe('Ed25519 256-bit');
    expect(formatDkimKey({ keyType: 'ed448', bits: 448, revoked: false })).toBe('Ed448 448-bit');
  });

  it('names a key it could not size by its type alone, and an unknown type as published', () => {
    expect(formatDkimKey({ keyType: 'rsa', bits: null, revoked: false })).toBe('RSA');
    expect(formatDkimKey({ keyType: 'ecdsa', bits: null, revoked: false })).toBe('ecdsa');
  });

  it('is empty for no key and for a revoked one', () => {
    expect(formatDkimKey(null)).toBe('');
    expect(formatDkimKey({ keyType: 'rsa', bits: null, revoked: true })).toBe('');
  });
});
