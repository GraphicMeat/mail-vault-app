/**
 * Task 6: `backup_cancel`'s Tauri command and its app-side `BackupCancelToken`
 * are deleted outright — cancellation now lives only in the daemon's
 * per-account `DaemonState.backup_runs` (Task 4). `api.backupCancel(accountId)`
 * must route through transport.js's DAEMON_OWNED path (`send` -> `sendToDaemon`),
 * not fall through to the (now-deleted) Tauri command, and must forward the
 * accountId the daemon's per-account cancel lookup requires — the old app-side
 * command took no accountId at all (a single global token), so a caller that
 * forgets to pass one would silently cancel nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import * as transport from '../../src/services/transport.js';
import * as api from '../../src/services/api.js';

describe('backupCancel routing (Task 6)', () => {
  it('backup_cancel is DAEMON_OWNED', () => {
    expect(transport.DAEMON_OWNED.has('backup_cancel')).toBe(true);
  });

  it('backupCancel routes through the daemon transport, not tauriInvoke, and forwards accountId', () => {
    const sendSpy = vi.spyOn(transport, 'send').mockResolvedValue(undefined);
    api.backupCancel('acct-1');
    expect(sendSpy).toHaveBeenCalledWith('backup_cancel', { accountId: 'acct-1' });
    sendSpy.mockRestore();
  });
});
