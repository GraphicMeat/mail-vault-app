// @vitest-environment jsdom
//
// Gmail rule: mail from a Google account is only ever processed by on-device AI.
// These cover the frontend half (the daemon enforces the same rule in
// src-daemon/src/ai_gate.rs): which accounts count as Google, which endpoints
// count as on-device, the provider swap, and what `generate` puts on the wire.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../daemonClient', () => ({ daemonCall: vi.fn() }));
import { daemonCall } from '../daemonClient';
import { useSettingsStore } from '../../stores/settingsStore';
import { useMailStore } from '../../stores/mailStore';
import {
  accountIdsOf, aiErrorText, E_GOOGLE_MAIL_ON_DEVICE_ONLY, endpointIsOnDevice, generate, isGoogleAccount,
  isOnDevice, mailMustStayOnDevice, providerForMail,
} from '../aiClient';

const CLOUD = { type: 'endpoint', url: 'https://api.openai.com/v1', model: 'gpt' };
const ACCOUNTS = [
  { id: 'g-oauth', email: 'a@gmail.com', authType: 'oauth2', oauth2Provider: 'google', imapHost: 'imap.gmail.com' },
  { id: 'g-imap', email: 'b@gmail.com', authType: 'password', imapHost: 'IMAP.Gmail.com' },
  { id: 'ms', email: 'c@outlook.com', authType: 'oauth2', oauth2Provider: 'microsoft', imapHost: 'outlook.office365.com' },
  { id: 'plain', email: 'd@fastmail.com', authType: 'password', imapHost: 'imap.fastmail.com' },
];

/** `ai.providers` answers for the on-device fallback. */
function providersAvailable(...available) {
  daemonCall.mockImplementation((method) => {
    if (method === 'ai.providers') {
      return Promise.resolve(['appleFm', 'localGguf', 'endpoint'].map(provider => ({ provider, available: available.includes(provider), reason: '' })));
    }
    return Promise.resolve({ text: 'generated' });
  });
}

const generateCall = () => daemonCall.mock.calls.find(([method]) => method === 'ai.generate');

beforeEach(() => {
  daemonCall.mockReset();
  useMailStore.setState({ accounts: ACCOUNTS, activeAccountId: 'plain' });
  useSettingsStore.setState({
    aiSettings: { enabled: true, provider: 'endpoint', endpointUrl: 'https://api.openai.com/v1', endpointModel: 'gpt', endpointConsented: true },
  });
});

describe('isGoogleAccount', () => {
  it('is Google OAuth, or IMAP on a Gmail host, trimmed and case-insensitive', () => {
    expect(isGoogleAccount(ACCOUNTS[0])).toBe(true);
    expect(isGoogleAccount(ACCOUNTS[1])).toBe(true);
    expect(isGoogleAccount({ imapHost: ' imap.googlemail.com ' })).toBe(true);
    expect(isGoogleAccount({ authType: ' OAuth2', oauth2Provider: 'GOOGLE' })).toBe(true);
    expect(isGoogleAccount(ACCOUNTS[2])).toBe(false);
    expect(isGoogleAccount(ACCOUNTS[3])).toBe(false);
    expect(isGoogleAccount({ imapHost: 'imap.gmail.com.evil.test' })).toBe(false);
    expect(isGoogleAccount({})).toBe(false);
    expect(isGoogleAccount(null)).toBe(false);
  });
});

describe('endpointIsOnDevice / isOnDevice', () => {
  it('trusts only a loopback host', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:11434', 'http://127.1.2.3', 'http://[::1]:11434/v1', 'https://LOCALHOST/v1']) {
      expect(endpointIsOnDevice(url), url).toBe(true);
    }
    for (const url of ['http://192.168.1.5:11434', 'https://api.openai.com/v1', 'http://localhost.evil.com', 'http://localhost@evil.com', 'http://my-mac.local', 'localhost:11434', 'not a url', '']) {
      expect(endpointIsOnDevice(url), url).toBe(false);
    }
  });

  it('reads Apple and the downloaded model as on-device, an endpoint by its URL', () => {
    expect(isOnDevice({ type: 'appleFm' })).toBe(true);
    expect(isOnDevice({ type: 'localGguf' })).toBe(true);
    expect(isOnDevice({ type: 'endpoint', url: 'http://localhost:11434/v1' })).toBe(true);
    expect(isOnDevice(CLOUD)).toBe(false);
    expect(isOnDevice(null)).toBe(false);
  });
});

describe('mailMustStayOnDevice', () => {
  it('is true for a Google account, an unknown one, or none at all', () => {
    expect(mailMustStayOnDevice(['g-oauth'])).toBe(true);
    expect(mailMustStayOnDevice(['plain', 'g-imap'])).toBe(true);
    expect(mailMustStayOnDevice(['no-such-account'])).toBe(true);
    expect(mailMustStayOnDevice([])).toBe(true);
    expect(mailMustStayOnDevice(undefined)).toBe(true);
    expect(mailMustStayOnDevice(['plain', 'ms'])).toBe(false);
  });
});

describe('accountIdsOf', () => {
  it('names every distinct account, falling back to the one being read', () => {
    expect(accountIdsOf([{ _accountId: 'g-oauth' }, { _accountId: 'plain' }, { _accountId: 'g-oauth' }], 'ms')).toEqual(['g-oauth', 'plain']);
    expect(accountIdsOf([{ uid: 1 }, { _srcAccountId: 'ms' }], 'plain')).toEqual(['plain', 'ms']);
    expect(accountIdsOf([{ uid: 1 }], undefined)).toEqual([]);
  });
});

describe('providerForMail', () => {
  it('keeps a cloud endpoint for mail that is not Google', async () => {
    const out = await providerForMail(CLOUD, ['plain', 'ms']);
    expect(out).toEqual({ provider: CLOUD, switched: false, refused: false });
    expect(daemonCall).not.toHaveBeenCalled();
  });

  it('swaps a cloud endpoint for Apple Intelligence when Google mail is involved', async () => {
    providersAvailable('appleFm', 'localGguf');
    expect(await providerForMail(CLOUD, ['plain', 'g-oauth'])).toEqual({ provider: { type: 'appleFm' }, switched: true, refused: false });
  });

  it('falls back to the downloaded model when Apple Intelligence is not available', async () => {
    providersAvailable('localGguf');
    expect(await providerForMail(CLOUD, ['g-imap'])).toEqual({ provider: { type: 'localGguf' }, switched: true, refused: false });
  });

  it('refuses when no on-device provider is available', async () => {
    providersAvailable();
    expect(await providerForMail(CLOUD, ['g-oauth'])).toEqual({ provider: null, switched: false, refused: true });
  });

  it('refuses when the daemon cannot say what is available', async () => {
    daemonCall.mockRejectedValue(new Error('daemon offline'));
    expect((await providerForMail(CLOUD, ['g-oauth'])).refused).toBe(true);
  });

  it('never swaps an on-device provider, whatever the accounts', async () => {
    for (const provider of [{ type: 'localGguf' }, { type: 'appleFm' }, { type: 'endpoint', url: 'http://localhost:11434/v1', model: 'm' }]) {
      expect((await providerForMail(provider, ['g-oauth'])).provider).toBe(provider);
    }
    expect(daemonCall).not.toHaveBeenCalled();
  });
});

describe('generate', () => {
  it('sends the accounts the prompt came from', async () => {
    providersAvailable();
    await generate({ prompt: 'p', provider: CLOUD, accountIds: ['plain', 'ms'], maxTokens: 5 });
    expect(generateCall()[1]).toEqual({ provider: CLOUD, prompt: 'p', system: undefined, maxTokens: 5, accountIds: ['plain', 'ms'] });
  });

  it('puts Google mail on an on-device provider instead of the chosen cloud one', async () => {
    providersAvailable('appleFm');
    await generate({ prompt: 'p', provider: CLOUD, accountIds: ['g-oauth'] });
    expect(generateCall()[1].provider).toEqual({ type: 'appleFm' });
    expect(generateCall()[1].accountIds).toEqual(['g-oauth']);
  });

  it('throws the refusal, and sends nothing, when Google mail has nowhere on-device to go', async () => {
    providersAvailable();
    const error = await generate({ prompt: 'p', provider: CLOUD, accountIds: ['g-imap'] }).catch(e => e);
    expect(error.code).toBe(E_GOOGLE_MAIL_ON_DEVICE_ONLY);
    expect(generateCall()).toBeUndefined();
  });

  it('treats a request that names no account like Google mail', async () => {
    providersAvailable();
    const error = await generate({ prompt: 'p', provider: CLOUD }).catch(e => e);
    expect(error.code).toBe(E_GOOGLE_MAIL_ON_DEVICE_ONLY);
    expect(generateCall()).toBeUndefined();
  });

  it('lets a prompt that holds no mail say so (the Settings test)', async () => {
    providersAvailable();
    await generate({ prompt: 'p', provider: CLOUD, noMailContent: true });
    expect(generateCall()[1]).toMatchObject({ provider: CLOUD, noMailContent: true });
    expect(generateCall()[1].accountIds).toBeUndefined();
  });

  it('keeps the on-device providers working for Google mail', async () => {
    providersAvailable();
    await generate({ prompt: 'p', provider: { type: 'localGguf' }, accountIds: ['g-oauth'] });
    expect(generateCall()[1]).toMatchObject({ provider: { type: 'localGguf' }, accountIds: ['g-oauth'] });
  });
});

describe('aiErrorText', () => {
  const t = key => `<${key}>`;
  it('maps the daemon refusal code to its catalog key, and leaves other errors alone', () => {
    expect(aiErrorText(new Error('E_GOOGLE_MAIL_ON_DEVICE_ONLY: Gmail messages are only processed by on-device AI.'), t)).toBe('<ai.googleMailOnDeviceOnly>');
    expect(aiErrorText(new Error('E_NO_ON_DEVICE_MODEL: no on-device AI is available'), t)).toBe('<ai.noOnDeviceModel>');
    expect(aiErrorText(new Error('boom'), t)).toBe('boom');
    expect(aiErrorText(new Error('boom'), t, 'fallback')).toBe('fallback');
  });
});
