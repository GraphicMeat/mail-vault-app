import { describe, it, expect, vi } from 'vitest';

let resolveDaemon;
vi.mock('../../services/daemonClient', () => ({
  daemonCall: vi.fn(() => new Promise((res) => { resolveDaemon = res; })),
}));

import { hydrateContactsIndex, isContactsIndexHydrated } from '../contactsIndex';

describe('isContactsIndexHydrated', () => {
  it('is false before hydrate resolves, true after, and false again when the account set changes', async () => {
    expect(isContactsIndexHydrated()).toBe(false);
    const p = hydrateContactsIndex([{ id: 'a1' }]);
    expect(isContactsIndexHydrated()).toBe(false);
    resolveDaemon({ a1: [] });
    await p;
    expect(isContactsIndexHydrated()).toBe(true);

    const p2 = hydrateContactsIndex([{ id: 'a1' }, { id: 'a2' }]);
    expect(isContactsIndexHydrated()).toBe(false);
    resolveDaemon({ a1: [], a2: [] });
    await p2;
    expect(isContactsIndexHydrated()).toBe(true);
  });
});
