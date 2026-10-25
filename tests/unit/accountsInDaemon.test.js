/**
 * Phase 1 step 0b: the daemon owns accounts.json (src-core/src/accounts_doc.rs,
 * src-daemon/src/handlers/accounts.rs) and is the one writer of the account
 * credentials blob (src-daemon/src/credentials.rs, handlers/credentials.rs).
 * The app's db/accounts.js and db/keychain.js are bindings: the shell's own
 * commands (`accounts_fallback`, `get_credentials`, `store_credentials`) stay
 * one release as the fallback, called from db/ only. CI never runs
 * `cargo test -p mailvault-daemon` on every path, so this reads the sources,
 * like learningInDaemon and authInDaemon.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (path) => readFileSync(path, 'utf8');
const transport = read('src/services/transport.js');
const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'), transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
const server = read('src-daemon/src/server.rs');
const handlersMod = read('src-daemon/src/handlers/mod.rs');
const demo = read('src/demo/backend.js');
const core = read('src-core/src/accounts_doc.rs');
const credHandler = read('src-daemon/src/handlers/credentials.rs');
const tokens = read('src-daemon/src/oauth_tokens.rs');
const shell = read('src-tauri/src/main.rs');
const accountsJs = read('src/services/db/accounts.js');
const keychainJs = read('src/services/db/keychain.js');
const en = JSON.parse(read('src/i18n/locales/en.json'));

const ACCOUNT_RPCS = ['accounts.list', 'accounts.get', 'accounts.put', 'accounts.remove', 'accounts.reorder', 'accounts.replace_all'];
const CREDENTIAL_RPCS = ['credentials.get', 'credentials.save', 'credentials.update', 'credentials.delete'];

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'demo') continue;
      out.push(...sources(path));
    } else if (/\.(js|jsx)$/.test(name) && !/\.test\.(js|jsx)$/.test(name)) {
      out.push(path.split('\\').join('/'));
    }
  }
  return out;
}
const SRC = sources('src').map((path) => ({ path, text: read(path) }));
const callers = (needle) => SRC.filter((f) => f.text.includes(needle)).map((f) => f.path).sort();

describe('the account list and the credentials live in the daemon', () => {
  it.each([...ACCOUNT_RPCS, ...CREDENTIAL_RPCS])('%s is daemon-owned, routed, bounded by the shell and stubbed in the demo', (rpc) => {
    expect(owned).toContain(`'${rpc}'`);
    expect(demo).toContain(`'${rpc}'`);
    expect(shell).toContain(`"${rpc}"`);
    if (rpc.startsWith('accounts.')) expect(core).toContain(`"${rpc}"`);
    else expect(credHandler).toContain(`"${rpc}" =>`);
  });

  it('the daemon chains both routers', () => {
    expect(handlersMod).toMatch(/pub\(crate\) mod accounts;/);
    expect(handlersMod).toMatch(/pub\(crate\) mod credentials;/);
    expect(server).toContain('crate::handlers::accounts::route(');
    expect(server).toContain('crate::handlers::credentials::route(');
  });

  it('token injection skips both namespaces, so no token rides into the list or a stored record', () => {
    const inject = tokens.slice(tokens.indexOf('pub(crate) async fn inject('));
    const beforeParams = inject.slice(0, inject.indexOf('params.as_object_mut()'));
    expect(beforeParams).toMatch(/if method\.starts_with\("accounts\."\) \|\| method\.starts_with\("credentials\."\) \{\s*return Injection/);
    expect(beforeParams).not.toMatch(/access_token\(|resolve_account_credentials\(/);
  });

  it('the app never reads or writes accounts.json itself', () => {
    expect(accountsJs).not.toMatch(/readTextFile|writeTextFile/);
    const fileWriters = SRC.filter((f) => /accounts\.json/.test(f.text) && /writeTextFile|writeFile\(/.test(f.text)).map((f) => f.path);
    expect(fileWriters).toEqual([]);
  });

  it('only db/ reaches the shell fallbacks, and only as fallbacks', () => {
    expect(callers("'store_credentials'")).toEqual(['src/services/db/keychain.js']);
    expect(callers("'get_credentials'")).toEqual(['src/services/db/keychain.js']);
    expect(callers("'accounts_fallback'")).toEqual(['src/services/db/accounts.js']);
    // The legacy per-account item (`com.mailvault.app` / <accountId>): no
    // reader anywhere, written next to the blob by the password and server
    // change workflows. Those move in stage 2; no new caller may appear.
    expect(callers("'store_password'")).toEqual(['src/components/settings/AccountSettings.jsx', 'src/services/api.js']);
  });

  it('every change is one account at a time: no caller hands the app a whole blob to write', () => {
    const wholeBlob = SRC.filter((f) => f.path !== 'src/services/db/keychain.js' && /\bsaveKeychain\(/.test(f.text)).map((f) => f.path);
    expect(wholeBlob).toEqual([]);
    expect(keychainJs).toMatch(/invoke\('credentials\.get'/);
  });

  it('every error the daemon answers here is a catalog key', () => {
    for (const key of ['errors.accountsConflict', 'errors.accountsInvalid', 'errors.accountsWriteFailed',
      'errors.keychainUnavailable', 'errors.keychainWriteFailed', 'errors.keychainBusy', 'errors.credentialsInvalid']) {
      expect(en[key], key).toBeTruthy();
    }
  });
});
