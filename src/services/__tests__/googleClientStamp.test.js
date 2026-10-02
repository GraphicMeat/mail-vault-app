import { describe, it, expect } from 'vitest';
import { googleClientFromStamp, GOOGLE_CLIENT_THUNDERBIRD, GOOGLE_CLIENT_MAILVAULT } from '../googleClient';

const TB = '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com';
const OURS = '708260940829-example.apps.googleusercontent.com';

describe('googleClientFromStamp', () => {
  it('reads an unstamped account as Thunderbird', () => {
    expect(googleClientFromStamp(undefined, { thunderbirdClientId: TB })).toBe(GOOGLE_CLIENT_THUNDERBIRD);
    expect(googleClientFromStamp('  ', null)).toBe(GOOGLE_CLIENT_THUNDERBIRD);
  });

  it('reads Thunderbird and MailVault stamps from the daemon list', () => {
    const clients = { thunderbirdClientId: TB, mailvaultClientId: OURS };
    expect(googleClientFromStamp(TB, clients)).toBe(GOOGLE_CLIENT_THUNDERBIRD);
    expect(googleClientFromStamp(OURS, clients)).toBe(GOOGLE_CLIENT_MAILVAULT);
  });

  // A Thunderbird account read as MailVault's would be moved by a plain Reconnect.
  it('still reads a Thunderbird stamp right when the daemon list failed to load', () => {
    expect(googleClientFromStamp(TB, { mailvault: false })).toBe(GOOGLE_CLIENT_THUNDERBIRD);
    expect(googleClientFromStamp(TB, undefined)).toBe(GOOGLE_CLIENT_THUNDERBIRD);
  });
});
