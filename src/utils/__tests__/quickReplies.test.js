// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isAutomatedThread, quickReplyThreadKey, threadShape, tier1Starters, tier2Starters } from '../quickReplies';
import { useSettingsStore } from '../../stores/settingsStore';

vi.mock('../../services/daemonClient', () => ({ daemonCall: vi.fn() }));
import { daemonCall } from '../../services/daemonClient';

const person = {
  from: { address: 'ann@example.test' },
  to: [{ address: 'me@example.test' }],
  subject: 'Lunch?',
  text: 'Are you free for lunch tomorrow?',
};

describe('isAutomatedThread — one case per suppression signal', () => {
  it('lets a plain person-to-person thread through', () => {
    expect(isAutomatedThread(person)).toBe(false);
  });

  it('suppresses on List-Unsubscribe', () => {
    expect(isAutomatedThread({ ...person, listUnsubscribe: '<mailto:off@list.test>' })).toBe(true);
  });

  it('suppresses on List-Id, even only in the header fallback', () => {
    expect(isAutomatedThread({ ...person, headers: { 'list-id': '"News" <news.example.test>' } })).toBe(true);
  });

  it('suppresses on Precedence: bulk', () => {
    expect(isAutomatedThread({ ...person, precedence: 'bulk' })).toBe(true);
  });

  it('suppresses when Reply-To differs from From', () => {
    expect(isAutomatedThread({ ...person, replyTo: { address: 'newsletter@other.test' } })).toBe(true);
  });

  it('suppresses on a large recipient count', () => {
    const to = Array.from({ length: 20 }, (_, i) => ({ address: `person${i}@example.test` }));
    expect(isAutomatedThread({ ...person, to })).toBe(true);
  });

  it('is false for no email', () => {
    expect(isAutomatedThread(null)).toBe(false);
  });
});

describe('quickReplyThreadKey', () => {
  it('prefers the root of the References chain over a uid or messageId', () => {
    expect(quickReplyThreadKey({ references: '<root@x> <mid@x>', inReplyTo: '<mid@x>', messageId: '<mid2@x>', uid: 99 }))
      .toBe('<root@x>');
  });

  it('falls back to inReplyTo, then messageId', () => {
    expect(quickReplyThreadKey({ inReplyTo: '<mid@x>', messageId: '<mid2@x>' })).toBe('<mid@x>');
    expect(quickReplyThreadKey({ messageId: '<mid2@x>' })).toBe('<mid2@x>');
  });

  it('is empty for a message with no threading headers at all', () => {
    expect(quickReplyThreadKey({})).toBe('');
  });
});

describe('threadShape / tier1Starters — one case per thread shape', () => {
  // Module-level `t` defaults to the English catalog (see i18n/index.js) —
  // these are its real English strings, not raw keys.
  it('reads a proposed time', () => {
    const email = { subject: 'Meeting', text: 'Does Tuesday at 3pm work for you?' };
    expect(threadShape(email)).toBe('proposedTime');
    expect(tier1Starters(email)).toEqual(["That works for me", "That doesn't work for me", 'Can we find another time?']);
  });

  it('reads a plain question', () => {
    const email = { subject: 'Quick one', text: 'Did you send the invoice?' };
    expect(threadShape(email)).toBe('question');
    expect(tier1Starters(email)).toEqual(['Yes', 'No', 'Let me check and get back to you']);
  });

  it('reads a plain request/statement as the fallback shape', () => {
    const email = { subject: 'FYI', text: 'Please review the attached doc.' };
    expect(threadShape(email)).toBe('request');
    expect(tier1Starters(email)).toEqual(["Got it, I'll take care of it"]);
  });
});

describe('tier2Starters — falls back to Tier 1 on failure', () => {
  beforeEach(() => {
    daemonCall.mockReset();
    useSettingsStore.setState({
      aiSettings: { enabled: true, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false },
    });
  });

  it('returns three starters parsed from the provider reply', async () => {
    daemonCall.mockResolvedValue({ text: 'Sounds good\nCan we push it a day?\nLet me check' });
    const result = await tier2Starters(person);
    expect(result).toEqual(['Sounds good', 'Can we push it a day?', 'Let me check']);
  });

  it('returns null (Tier 1 fallback) when the daemon call rejects', async () => {
    daemonCall.mockRejectedValue(new Error('no model loaded'));
    const result = await tier2Starters(person);
    expect(result).toBeNull();
  });

  it('never calls the daemon for a non-local provider without prior consent', async () => {
    useSettingsStore.setState({
      aiSettings: { enabled: true, provider: 'endpoint', endpointUrl: 'http://localhost:11434/v1', endpointModel: 'llama3', endpointConsented: false },
    });
    const result = await tier2Starters(person);
    expect(result).toBeNull();
    expect(daemonCall).not.toHaveBeenCalled();
  });

  it('is null outright when AI features are off', async () => {
    useSettingsStore.setState({ aiSettings: { enabled: false, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false } });
    const result = await tier2Starters(person);
    expect(result).toBeNull();
    expect(daemonCall).not.toHaveBeenCalled();
  });
});
