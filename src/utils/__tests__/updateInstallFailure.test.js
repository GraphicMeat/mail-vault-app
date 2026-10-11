// Sparkle reports the stage an update died in as an NSError: domain
// SUSparkleErrorDomain, code by phase (1000s appcast, 2000s download, 3000s
// extraction, 4000s installation). Only two installation codes mean "the
// installer never got going, the download is intact, a fresh app process can
// finish it": 4005 SUInstallationError (the installer's port went away, as
// when macOS refused it its cache folder on the app's first run) and 4010
// SUAgentInvalidationError (its progress agent went away). Everything else is
// either not an install failure or not helped by a restart.
import { describe, expect, it } from 'vitest';
import { isRecoverableInstallFailure } from '../updateInstallFailure';

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
