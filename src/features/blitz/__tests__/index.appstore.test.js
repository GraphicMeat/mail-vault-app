// @vitest-environment jsdom
// The Mac App Store shell is built without the render feature (no mvrender
// scheme), so a registered Blitz there would offer a setting whose every tile
// fails. The module registers nothing in that build.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const register = vi.hoisted(() => vi.fn());
vi.mock('../../../components/email/bodyRendererRegistry', () => ({ registerBodyRenderer: register }));

const load = async () => { vi.resetModules(); await import('../index.js'); };

beforeEach(() => { register.mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('blitz module registration', () => {
  it('registers the renderer, body and settings row, in an ordinary build', async () => {
    vi.stubEnv('VITE_MV_APPSTORE', '');
    await load();
    expect(register).toHaveBeenCalledTimes(1);
    const [name, impl] = register.mock.calls[0];
    expect(name).toBe('blitz');
    // A forwardRef component: the reply selection handle is read through its ref.
    expect(impl.Body.$$typeof).toBe(Symbol.for('react.forward_ref'));
    expect(typeof impl.SettingsRow).toBe('function');
  });

  it('registers nothing in a Mac App Store build: no body, no settings row', async () => {
    vi.stubEnv('VITE_MV_APPSTORE', '1');
    await load();
    expect(register).not.toHaveBeenCalled();
  });
});
