import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { collectPrivacyNames, setPrivacyDictionary, getPrivacyDictionary, usePrivacyDictStore, isPrivacyDictionaryReady, ensurePrivacyDictionary } from '../privacyDictionary';
import { buildNameDictionary } from '../piiDetector';
import { usePrivacyStore } from '../../../stores/privacyStore';

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

  describe('ensurePrivacyDictionary', () => {
    const settled = (p) => { let done = false; p.then(() => { done = true; }); return () => done; };
    beforeEach(() => { usePrivacyStore.setState({ enabled: false, captureMask: false, dictWanted: false }); });
    afterEach(() => { vi.useRealTimers(); });

    it('returns at once when a running host (privacy mode on) has the dictionary ready', async () => {
      usePrivacyStore.setState({ enabled: true });
      setPrivacyDictionary(buildNameDictionary({ names: ['Yan Po'] }), { ready: true });
      expect((await ensurePrivacyDictionary()).tokens.has('yan')).toBe(true);
      expect(usePrivacyStore.getState().dictWanted).toBe(false);
    });

    it('waking an idle host waits for its next build, not a ready flag left from an earlier one', async () => {
      setPrivacyDictionary(buildNameDictionary({ names: ['Old Name'] }), { ready: true });
      const p = ensurePrivacyDictionary(60_000);
      const done = settled(p);
      expect(usePrivacyStore.getState().dictWanted).toBe(true);
      await Promise.resolve(); await Promise.resolve();
      expect(done()).toBe(false);
      setPrivacyDictionary(buildNameDictionary({ names: ['Xavi Lund'] }), { ready: true });
      expect((await p).tokens.has('xavi')).toBe(true);
      expect(usePrivacyStore.getState().dictWanted).toBe(false);
    });

    it('a build that is not ready yet keeps it waiting', async () => {
      const p = ensurePrivacyDictionary(60_000);
      const done = settled(p);
      setPrivacyDictionary(buildNameDictionary({ names: ['Vera Mott'] }), { ready: false });
      await Promise.resolve(); await Promise.resolve();
      expect(done()).toBe(false);
      setPrivacyDictionary(buildNameDictionary({ names: ['Vera Mott', 'Uma Kerr'] }), { ready: true });
      expect((await p).tokens.has('uma')).toBe(true);
    });

    it('gives up after 10 s by default with what it has', async () => {
      vi.useFakeTimers();
      const p = ensurePrivacyDictionary();
      const done = settled(p);
      setPrivacyDictionary(buildNameDictionary({ names: ['Wim Ode'] }), { ready: false });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(done()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await p).tokens.has('wim')).toBe(true);
      expect(usePrivacyStore.getState().dictWanted).toBe(false);
    });

    it('overlapping callers share the flag: it drops when the last one is done', async () => {
      vi.useFakeTimers();
      const first = ensurePrivacyDictionary(100);
      const second = ensurePrivacyDictionary(10_000);
      await vi.advanceTimersByTimeAsync(100);
      await first;
      expect(usePrivacyStore.getState().dictWanted).toBe(true);
      setPrivacyDictionary(buildNameDictionary({ names: ['Tess Lyn'] }), { ready: true });
      expect((await second).tokens.has('tess')).toBe(true);
      expect(usePrivacyStore.getState().dictWanted).toBe(false);
    });
  });
});
