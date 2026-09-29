import { beforeEach, describe, expect, it } from 'vitest';
import { useAbdStore, selectPanelJob } from '../abdStore';
import { pillPercent, keptReasons, isDrivePaused, isStalled } from '../../utils/abdFrame';

const frame = (over = {}) => ({
  jobId: 'abd-a-1', accountId: 'a', accountEmail: 'a@x.test', mode: 'archive_delete',
  status: { state: 'running', phase: 'download' },
  counts: { scoped: 100, stored: 0, vaultVerified: 0, onDrive: 0, deleted: 0, emptied: 0, kept: 0, keptByReason: {} },
  finished: false, outcome: null, error: null, updatedMs: 10, ...over,
});
const s = () => useAbdStore.getState();

beforeEach(() => useAbdStore.setState({ jobs: {}, previews: {}, panel: null }));

describe('applyFrame', () => {
  it('keeps the newest frame of a job and drops one that arrives late', () => {
    s().applyFrame(frame({ updatedMs: 20, counts: { ...frame().counts, deleted: 7 } }));
    s().applyFrame(frame({ updatedMs: 10, counts: { ...frame().counts, deleted: 3 } }));
    expect(s().jobs.a.counts.deleted).toBe(7);
    s().applyFrame(frame({ updatedMs: 20, counts: { ...frame().counts, deleted: 8 } }));
    expect(s().jobs.a.counts.deleted).toBe(8);
  });

  it('takes a new job of the same account whatever its timestamp', () => {
    s().applyFrame(frame({ updatedMs: 500 }));
    s().applyFrame(frame({ jobId: 'abd-a-2', updatedMs: 5 }));
    expect(s().jobs.a.jobId).toBe('abd-a-2');
  });

  it('never brings a finished job back to life', () => {
    s().applyFrame(frame({ updatedMs: 30, finished: true, outcome: 'completed', status: { state: 'completed' } }));
    s().applyFrame(frame({ updatedMs: 40 }));
    expect(s().jobs.a.finished).toBe(true);
  });

  it('opens an unfinished job minimized when no panel is open, and leaves an open panel alone', () => {
    s().applyFrame(frame());
    expect(s().panel).toEqual({ accountId: 'a', minimized: true });
    s().openPanel('a');
    s().applyFrame(frame({ jobId: 'abd-b-1', accountId: 'b', accountEmail: 'b@x.test' }));
    expect(s().panel).toEqual({ accountId: 'a', minimized: false });
  });

  it('opens nothing for a job that is already over', () => {
    s().applyFrame(frame({ finished: true, outcome: 'completed', status: { state: 'completed' } }));
    expect(s().panel).toBeNull();
  });

  it('brings a minimized panel back when its job ends, and only then', () => {
    s().applyFrame(frame({ updatedMs: 1 }));
    expect(s().panel.minimized).toBe(true);
    s().applyFrame(frame({ updatedMs: 2, counts: { ...frame().counts, deleted: 50 } }));
    expect(s().panel.minimized).toBe(true);
    s().applyFrame(frame({ updatedMs: 3, finished: true, outcome: 'completed', status: { state: 'completed' } }));
    expect(s().panel).toEqual({ accountId: 'a', minimized: false });
  });

  it('ignores a frame with no account', () => {
    s().applyFrame({ jobId: 'x' });
    s().applyFrame(null);
    expect(s().jobs).toEqual({});
  });
});

describe('panel', () => {
  it('minimizes, restores and closes without touching the job', () => {
    s().applyFrame(frame());
    s().openPanel('a');
    s().minimize();
    expect(s().panel).toEqual({ accountId: 'a', minimized: true });
    s().restore();
    expect(s().panel).toEqual({ accountId: 'a', minimized: false });
    s().closePanel();
    expect(s().panel).toBeNull();
    expect(s().jobs.a).toBeTruthy();
  });

  it('selectPanelJob is the frame of the panel account, or null', () => {
    expect(selectPanelJob(s())).toBeNull();
    s().applyFrame(frame());
    s().openPanel('a');
    expect(selectPanelJob(s()).jobId).toBe('abd-a-1');
  });

  it('removeJob closes the panel that showed it', () => {
    s().applyFrame(frame());
    s().openPanel('a');
    s().removeJob('a');
    expect(s().jobs).toEqual({});
    expect(s().panel).toBeNull();
  });

  it('patchStatus changes an unfinished job, never a finished one', () => {
    s().applyFrame(frame());
    s().patchStatus('a', { state: 'paused', reason: 'user' });
    expect(s().jobs.a.status).toEqual({ state: 'paused', reason: 'user' });
    s().applyFrame(frame({ updatedMs: 99, finished: true, outcome: 'cancelled', status: { state: 'cancelled' } }));
    s().patchStatus('a', { state: 'running' });
    expect(s().jobs.a.status.state).toBe('cancelled');
  });
});

describe('previews', () => {
  it('follows only the current run of an account', () => {
    s().beginPreview('a', 'p1');
    s().applyPreview({ accountId: 'a', previewId: 'p0', state: 'ready' });
    expect(s().previews.a.state).toBe('listing');
    s().applyPreview({ accountId: 'a', previewId: 'p1', state: 'listing', folder: 'INBOX', listed: 12 });
    expect(s().previews.a).toMatchObject({ folder: 'INBOX', listed: 12 });
    s().applyPreview({ accountId: 'a', previewId: 'p1', state: 'failed', error: 'no route' });
    expect(s().previews.a).toMatchObject({ state: 'failed', error: 'no route' });
  });

  it('a new run replaces the old one, and events for a cleared run go nowhere', () => {
    s().beginPreview('a', 'p1');
    s().beginPreview('a', 'p2');
    s().applyPreview({ accountId: 'a', previewId: 'p1', state: 'ready' });
    expect(s().previews.a).toMatchObject({ previewId: 'p2', state: 'listing' });
    s().clearPreview('a');
    s().applyPreview({ accountId: 'a', previewId: 'p2', state: 'ready' });
    expect(s().previews.a).toBeUndefined();
  });
});

describe('frame helpers', () => {
  it('pillPercent averages the steps a message goes through, and leaves kept mail out', () => {
    const f = (counts, mode = 'archive_delete') => frame({ mode, counts: { ...frame().counts, ...counts } });
    expect(pillPercent(f({}))).toBe(0);
    expect(pillPercent(f({ vaultVerified: 100, deleted: 0 }))).toBe(50);
    expect(pillPercent(f({ vaultVerified: 100, deleted: 100 }))).toBe(100);
    // Backup mode has a third step: the drive.
    expect(pillPercent(f({ vaultVerified: 100, onDrive: 0, deleted: 0 }, 'archive_backup_delete'))).toBe(33);
    // 20 of 100 stay on the server; 80 saved and deleted is all there is to do.
    expect(pillPercent(f({ scoped: 100, kept: 20, vaultVerified: 80, deleted: 80 }))).toBe(100);
    expect(pillPercent(f({ scoped: 10, kept: 10 }))).toBe(0);
    expect(pillPercent(frame({ finished: true, outcome: 'completed', counts: { scoped: 0, kept: 0 } }))).toBe(100);
  });

  it('keptReasons lists reasons largest first and skips zeros', () => {
    const f = frame({ counts: { ...frame().counts, kept: 6, keptByReason: { server_changed: 1, download_failed: 5, vault_missing: 0 } } });
    expect(keptReasons(f)).toEqual([['download_failed', 5], ['server_changed', 1]]);
  });

  it('says when a job waits on the backup drive', () => {
    expect(isDrivePaused(frame({ status: { state: 'paused', reason: 'drive_unavailable' } }))).toBe(true);
    expect(isDrivePaused(frame({ status: { state: 'paused', reason: 'user' } }))).toBe(false);
    expect(isStalled(frame({ status: { state: 'waiting', reason: 'daily_limit', untilMs: 1 } }))).toBe(true);
    expect(isStalled(frame())).toBe(false);
  });
});
