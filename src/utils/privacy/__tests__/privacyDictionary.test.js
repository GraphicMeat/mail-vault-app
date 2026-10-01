import { describe, it, expect } from 'vitest';
import { collectPrivacyNames, setPrivacyDictionary, getPrivacyDictionary, usePrivacyDictStore, isPrivacyDictionaryReady } from '../privacyDictionary';
import { buildNameDictionary } from '../piiDetector';

describe('privacyDictionary', () => {
  it('collects names from contacts, every header party of loaded mail, and own accounts', () => {
    const names = collectPrivacyNames({
      contacts: [{ name: 'Ann Lee', address: 'ann@x.com' }],
      emails: [{ from: { name: 'Bo Ray', address: 'b@x' }, to: [{ name: 'Cy Dun' }], cc: [{ name: 'Di Eve' }], bcc: [], replyTo: [{ name: 'Ed Fox' }] }],
      accounts: [{ name: 'Rokas A', email: 'r@x' }],
      displayNames: { a1: 'Work Rokas' },
    });
    expect(names).toEqual(expect.arrayContaining(['Ann Lee', 'Bo Ray', 'Cy Dun', 'Di Eve', 'Ed Fox', 'Rokas A', 'Work Rokas']));
  });
  it('accepts "Name <addr>" strings', () => {
    expect(collectPrivacyNames({ emails: [{ from: 'Gil Hu <g@x>' }] })).toContain('Gil Hu');
  });
  it('bumps version and ready on set', () => {
    const v = usePrivacyDictStore.getState().version;
    setPrivacyDictionary(buildNameDictionary({ names: ['Zed Q'] }), { ready: true });
    expect(usePrivacyDictStore.getState().version).toBe(v + 1);
    expect(isPrivacyDictionaryReady()).toBe(true);
    expect(getPrivacyDictionary().tokens.has('zed')).toBe(true);
  });
});
