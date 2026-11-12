// @vitest-environment jsdom
//
// The portable store reaches the keychain retry workflow through a port. A
// locked -> unlocked transition must call it exactly once (a missing port
// binding or an undefined identifier would throw here).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/daemonClient', () => ({
  daemonCall: vi.fn(() => new Promise(() => {})),
  DaemonError: class DaemonError extends Error {},
}));

const { usePortableStore, __resetPortableForTests } = await import('../portableStore');
const { bindWorkflowPorts } = await import('../workflowPorts');

const retry = vi.fn(() => Promise.resolve(true));
bindWorkflowPorts({ retryKeychainAccess: (...a) => retry(...a) });

beforeEach(() => {
  __resetPortableForTests();
  retry.mockClear();
});

describe('portableStore', () => {
  it('re-reads the accounts through the retryKeychainAccess port once the drive unlocks', () => {
    const { apply } = usePortableStore.getState();
    apply({ portable: true, locked: true });
    expect(retry).not.toHaveBeenCalled();
    apply({ portable: true, locked: false });
    expect(retry).toHaveBeenCalledTimes(1);
    // A repeated unlocked status is not another unlock.
    apply({ portable: true, locked: false });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
