/**
 * Phase 1, row 5: what an account's download mode keeps, what its daily
 * transfer limits are and when the banner warns, and which server mailbox a
 * vault directory holds are the daemon's (`policy.accounts`,
 * `policy.vault_mailboxes`, src-daemon/src/handlers/policy.rs, rules in
 * src-core/src/fetch_mode.rs, transfer_limits.rs and search_index/text.rs).
 * Whether a Google sign-in is the mailbox the user typed is answered by
 * `oauth2_exchange` itself (`emailMatches`). The app shows the answers and
 * computes none of them. CI never runs `cargo test -p mailvault-daemon`, so
 * this reads the sources, same pattern as `senderCheckInDaemon`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { listSourceFiles } from '../../scripts/lib/sourceFiles.mjs';

const read = (path) => readFileSync(path, 'utf8');
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const METHODS = ['policy.accounts', 'policy.vault_mailboxes'];

describe('download mode, transfer limits and vault folder names live in the daemon', () => {
  it('the JS ports are gone', () => {
    for (const gone of ['src/utils/fetchPolicy.js', 'src/utils/transferLimits.js']) {
      expect(existsSync(gone), gone).toBe(false);
    }
  });

  it.each(METHODS)('the daemon routes %s from its own handler file', (method) => {
    expect(read('src-daemon/src/handlers/policy.rs')).toContain(`"${method}"`);
  });

  it('the handler is declared and in the route chain, its rules in src-core', () => {
    expect(read('src-daemon/src/handlers/mod.rs')).toMatch(/pub\(crate\) mod policy;/);
    expect(code(read('src-daemon/src/server.rs'))).toMatch(/crate::handlers::policy::route\(/);
    expect(read('src-core/src/fetch_mode.rs')).toMatch(/pub fn keep_bodies\(/);
    expect(read('src-core/src/transfer_limits.rs')).toMatch(/pub fn display_limits\(/);
    expect(read('src-core/src/transfer_limits.rs')).toMatch(/pub fn warning\(/);
    expect(read('src-core/src/search_index/text.rs')).toMatch(/pub fn mailboxes_from_vault_dirs\(/);
  });

  it.each(METHODS)('the app reaches %s as a daemon-owned command, and the browser demo answers it', (method) => {
    expect(read('src/services/transport.js')).toContain(`'${method}'`);
    expect(read('src/demo/backend.js')).toContain(`'${method}'`);
  });

  it('no app source resolves a download mode, a limit or a vault folder name itself', () => {
    const files = listSourceFiles(['src'], ['.js', '.jsx'], { exclude: ['__tests__', '__mocks__', '.test.', '.spec.', 'src/demo/'] });
    const offenders = files.filter((f) => {
      const src = code(read(f));
      return /\b(fetchPolicy|keepsBody|resolveDailyLimitBytes|providerDefaultBytes|isGmailAccount|vaultDirName|mailboxPathFromVaultDir)\s*\(/.test(src)
        || /GMAIL_(LIMIT|DEFAULT)_(DOWN|UP)_BYTES|VAULT_UNSAFE_RE/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('the surfaces ask the daemon', () => {
    expect(code(read('src/services/accountPolicy.js'))).toContain("'policy.accounts'");
    expect(code(read('src/services/EmailPipelineManager.js'))).toMatch(/accountPolicies\(/);
    expect(code(read('src/components/settings/VaultGapRow.jsx'))).toMatch(/useAccountPolicy\(/);
    expect(code(read('src/components/settings/DataUsageAccountCard.jsx'))).toMatch(/useAccountPolicy\(/);
    expect(code(read('src/components/TransferLimitBanner.jsx'))).toMatch(/accountPolicies\(/);
    expect(code(read('src/services/db/emails.js'))).toContain("'policy.vault_mailboxes'");
    expect(code(read('src/components/AccountModal.jsx'))).toMatch(/emailMatches === false/);
  });

  it('the daemon answers the sign-in identity check, the app sends what was typed', () => {
    expect(code(read('src-daemon/src/handlers/oauth2.rs'))).toMatch(/"emailMatches"/);
    expect(code(read('src/services/api.js'))).toMatch(/oauth2_exchange', \{ state, expectEmail \}/);
    expect(code(read('src/components/AccountModal.jsx'))).not.toMatch(/normalizeEmailIdentity/);
  });
});
