// Sparkle reports the stage an update died in as an NSError: domain
// SUSparkleErrorDomain, code by phase (1000s appcast, 2000s download, 3000s
// extraction, 4000s installation). Only two installation codes mean "the
// installer never got going, the download is intact, a fresh app process can
// finish it": 4005 SUInstallationError (the installer's port went away, as
// when macOS refused it its cache folder on the app's first run) and 4010
// SUAgentInvalidationError (its progress agent went away). Everything else is
// either not an install failure or not helped by a restart.
import { describe, expect, it, vi } from 'vitest';
import { createStaleDownloadRecheck, isRecoverableInstallFailure } from '../updateInstallFailure';

const sparkle = (code) => ({ domain: 'SUSparkleErrorDomain', code, message: 'x' });

describe('isRecoverableInstallFailure', () => {
  it('recognises the installer dying before it touched the app', () => {
    expect(isRecoverableInstallFailure(sparkle(4005))).toBe(true);
    expect(isRecoverableInstallFailure(sparkle(4010))).toBe(true);
  });

  it('leaves the other installation codes alone', () => {
    // 4004 relaunch failed: the update is in; 4006 downgrade; 4007 the user
    // cancelled; 4012 macOS App Management refused the write, a restart
    // changes nothing; 4003 the installer tool is missing from the bundle.
    for (const code of [4000, 4001, 4002, 4003, 4004, 4006, 4007, 4008, 4009, 4012]) {
      expect(isRecoverableInstallFailure(sparkle(code)), `code ${code}`).toBe(false);
    }
  });

  it('ignores the earlier phases and other domains', () => {
    expect(isRecoverableInstallFailure(sparkle(1001))).toBe(false); // no update
    expect(isRecoverableInstallFailure(sparkle(2001))).toBe(false); // download
    expect(isRecoverableInstallFailure(sparkle(3001))).toBe(false); // signature
    expect(isRecoverableInstallFailure({ domain: 'NSURLErrorDomain', code: 4005 })).toBe(false);
    expect(isRecoverableInstallFailure({ domain: 'NSPOSIXErrorDomain', code: 1 })).toBe(false);
  });

  it('survives a missing or malformed payload', () => {
    expect(isRecoverableInstallFailure(null)).toBe(false);
    expect(isRecoverableInstallFailure(undefined)).toBe(false);
    expect(isRecoverableInstallFailure({})).toBe(false);
    expect(isRecoverableInstallFailure({ domain: 'SUSparkleErrorDomain', code: '4005' })).toBe(false);
  });
});

// A download that dies (2000s) is usually an enclosure the feed no longer
// serves: the nightly prerelease is replaced every night and its DMG name
// carries the build stamp. Once Sparkle's cycle ends, one fresh check reads the
// current feed and offers what is there now. One per ten minutes, never a loop.
describe('createStaleDownloadRecheck', () => {
  const setup = () => {
    let t = 0;
    const recheck = vi.fn();
    const r = createStaleDownloadRecheck({ recheck, now: () => t });
    return { r, recheck, advance: (ms) => { t += ms; } };
  };

  it('checks the feed again once the failed download cycle has ended', () => {
    const { r, recheck } = setup();
    r.onAbort(sparkle(2001));
    expect(recheck).not.toHaveBeenCalled();
    r.onCycleFinished();
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a cycle that did not fail a download', () => {
    const { r, recheck } = setup();
    r.onCycleFinished();
    r.onAbort(sparkle(4005));
    r.onCycleFinished();
    r.onAbort({ domain: 'NSURLErrorDomain', code: 2001 });
    r.onCycleFinished();
    expect(recheck).not.toHaveBeenCalled();
  });

  it('never loops: a second failure soon after its re-check stands', () => {
    const { r, recheck, advance } = setup();
    r.onAbort(sparkle(2001));
    r.onCycleFinished();
    advance(60_000);
    r.onAbort(sparkle(2001));
    r.onCycleFinished();
    expect(recheck).toHaveBeenCalledTimes(1);
    advance(10 * 60_000);
    r.onAbort(sparkle(2001));
    r.onCycleFinished();
    expect(recheck).toHaveBeenCalledTimes(2);
  });
});
