import { afterEach, describe, expect, it, vi } from 'vitest';
import { jmapSessionHost } from '../providerKind.js';

// The e2e harness's mock JMAP server is plain http on loopback, and the
// jmap-account spec adds it through the real AccountModal. Only an e2e build
// (VITE_E2E=1, a build-time constant) may take such a URL; anything else
// stays refused exactly as before.
describe('jmapSessionHost in an e2e build', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('takes a plain-http loopback session URL when VITE_E2E is 1', () => {
    vi.stubEnv('VITE_E2E', '1');
    expect(jmapSessionHost('http://127.0.0.1:53211/jmap/session')).toBe('127.0.0.1');
    expect(jmapSessionHost('http://localhost:53211/jmap/session')).toBe('localhost');
    expect(jmapSessionHost('http://[::1]:53211/jmap/session')).toBe('[::1]');
  });

  it('still refuses plain http to any other host when VITE_E2E is 1', () => {
    vi.stubEnv('VITE_E2E', '1');
    expect(jmapSessionHost('http://jmap.example.test/jmap/session')).toBe('');
    expect(jmapSessionHost('http://127.0.0.1.example.test/jmap/session')).toBe('');
  });

  it('refuses a plain-http loopback session URL outside an e2e build', () => {
    vi.stubEnv('VITE_E2E', '');
    expect(jmapSessionHost('http://127.0.0.1:53211/jmap/session')).toBe('');
    expect(jmapSessionHost('https://api.fastmail.com/jmap/session')).toBe('api.fastmail.com');
  });
});
