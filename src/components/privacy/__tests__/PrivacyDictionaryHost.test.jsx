// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';

vi.mock('../../../services/daemonClient', () => ({ daemonCall: vi.fn(async () => ({})) }));

import { PrivacyDictionaryHost } from '../PrivacyDictionaryHost';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { useMailStore } from '../../../stores/mailStore';
import { getPrivacyDictionary, usePrivacyDictStore } from '../../../utils/privacy/privacyDictionary';

const mail = (name) => ({ uid: 1, from: { name, address: 'a@x.com' }, to: [], cc: [], bcc: [] });

afterEach(cleanup);
beforeEach(() => {
  usePrivacyStore.setState({ enabled: false, peek: false, captureMask: false });
  useMailStore.setState({ emails: [], sentEmails: [], selectedEmail: null, accounts: [] });
});

describe('PrivacyDictionaryHost', () => {
  it('stays idle while privacy is off', () => {
    const v = usePrivacyDictStore.getState().version;
    useMailStore.setState({ emails: [mail('Ann Lee')] });
    render(<PrivacyDictionaryHost />);
    expect(usePrivacyDictStore.getState().version).toBe(v);
  });

  it('learns names from loaded headers and only republishes when the name set changes', async () => {
    usePrivacyStore.setState({ enabled: true });
    render(<PrivacyDictionaryHost />);
    await act(async () => { useMailStore.setState({ emails: [mail('Ann Lee')] }); });
    expect(getPrivacyDictionary().tokens.has('ann')).toBe(true);
    const v = usePrivacyDictStore.getState().version;
    // A new array with the same names (a list reload) must not wake the readers.
    await act(async () => { useMailStore.setState({ emails: [mail('Ann Lee')] }); });
    expect(usePrivacyDictStore.getState().version).toBe(v);
    await act(async () => { useMailStore.setState({ emails: [mail('Ann Lee'), mail('Bobby Ray')] }); });
    expect(getPrivacyDictionary().tokens.has('bobby')).toBe(true);
    expect(usePrivacyDictStore.getState().version).toBe(v + 1);
  });

  it('never forgets a name this session: a folder switch must not unmask the open message', async () => {
    usePrivacyStore.setState({ enabled: true });
    render(<PrivacyDictionaryHost />);
    await act(async () => { useMailStore.setState({ emails: [mail('Carla Mendez')] }); });
    await act(async () => { useMailStore.setState({ emails: [mail('Dmitri Orlov')] }); });
    expect(getPrivacyDictionary().tokens.has('dmitri')).toBe(true);
    expect(getPrivacyDictionary().tokens.has('carla')).toBe(true);
  });
});
