/**
 * Phase 1 step 0c (docs plan 2026-10-19 phase1 migration order): the daemon
 * owns OAuth2 access-token freshness (`src-daemon/src/oauth_tokens.rs`). The
 * app no longer decides when to refresh a token and no longer hands one to a
 * daemon call: every request is given the daemon's own token on the way in
 * (`oauth_tokens::inject` in `server.rs`); native completion persists pairs.
 *
 * What stays in the app: the interactive sign-in (`oauth2_auth_url`,
 * `oauth2_exchange`, `withOAuth2Exchange`), the one probe of a token that sign-in
 * just returned (`graphProbeSignIn`), presence checks (`hasValidCredentials`)
 * and the keychain rehydration of `resolveServerAccount` (accounts move in 0b).
 *
 * CI never runs `cargo test -p mailvault-daemon`, so this reads the source,
 * like `networkInDaemon` and `vaultInDaemon`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'demo') continue;
      out.push(...sources(path));
    } else if (/\.(js|jsx)$/.test(name) && !/\.test\.(js|jsx)$/.test(name)) {
      out.push(path.split('\\').join('/')); // Windows joins with backslashes
    }
  }
  return out;
}

const SRC = sources('src').map(path => ({ path, text: readFileSync(path, 'utf8') }));
const read = (path) => readFileSync(path, 'utf8');
const files = (pattern) => SRC.filter(f => pattern.test(f.text)).map(f => f.path).sort();

describe('the app no longer refreshes OAuth2 tokens', () => {
  it('has no refresh decision left: ensureFreshToken and the forced refresh are gone', () => {
    expect(files(/\bensureFreshToken\b|\b_forceRefreshToken\b|\bresolveBackupAccount\b/)).toEqual([]);
  });

  it('never calls the oauth2_refresh RPC (the daemon keeps it for one release)', () => {
    expect(files(/\brefreshOAuth2Token\b/)).toEqual([]);
    const callers = SRC.filter(f => f.text.includes("'oauth2_refresh'")).map(f => f.path);
    expect(callers).toEqual(['src/services/transport.js']);
  });

  it('deleted the token-to-account lookup that only existed to name Graph calls', () => {
    expect(existsSync('src/services/tokenOwners.js')).toBe(false);
    expect(files(/tokenOwners/)).toEqual([]);
  });
});

describe('the app hands the daemon no token', () => {
  const api = read('src/services/api.js');

  it('names the account on every Graph call, never a token', () => {
    const graph = [...api.matchAll(/export async function (graph\w+)\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/g)];
    expect(graph.length).toBeGreaterThan(10);
    for (const [, name, args, body] of graph) {
      if (name === 'graphProbeSignIn' || name === 'graphAllocateUids') continue;
      expect(args, name).not.toMatch(/accessToken|token/i);
      expect(body, name).not.toMatch(/accessToken/);
    }
  });

  it('reads an access token only to save it, check it exists, or probe a sign-in it just got', () => {
    const allowed = [
      'src/components/AccountModal.jsx', // the new-account form's empty field
      'src/hooks/useEmailScheduler.js', // a change key, never sent
      'src/services/authUtils.js', // withOAuth2Exchange, hasValidCredentials
      'src/services/db/accounts.js', // account presence and metadata
      'src/services/oauthCredentialProjection.js', // fresh, read-only UI copy
      'src/services/syncService.js', // says why the payload leaves it out
      'src/services/workflows/activateAccount.js', // presence
      'src/services/workflows/addAccount.js', // probes the sign-in it just got
      'src/services/workflows/retryKeychainAccess.js', // presence
      'src/services/workflows/updateAccount.js', // probes a Reconnect's new sign-in
    ];
    expect(files(/oauth2AccessToken/).filter(p => !allowed.includes(p))).toEqual([]);
  });

  it('no longer leases a token to Archive & delete jobs', () => {
    const abd = read('src/services/abd.js');
    expect(abd).not.toMatch(/abd\.set_token/);
    expect(abd).not.toMatch(/abd-token-needed/);
  });
});

describe('the daemon owns the token', () => {
  const server = read('src-daemon/src/server.rs');
  const oauth2 = read('src-daemon/src/handlers/oauth2.rs');
  const tokens = read('src-daemon/src/oauth_tokens.rs');

  it('routes only credential-free sync, compose and backup controls before injection', () => {
    const handle = server.slice(server.indexOf('async fn handle_request('), server.indexOf('fn jmap_refusal_log_line')).replace(/\/\/[^\n]*/g, '');
    const exempt = /if matches!\(\s*method\.as_str\(\),\s*([^)]*)\s*\) \{\s*return route_request\(state, req\)\.await;\s*\}/.exec(handle);
    expect(exempt).not.toBeNull();
    expect([...exempt[1].matchAll(/"([^"]+)"/g)].map(match => match[1])).toEqual([
      'sync.probe', 'counts.unread', 'sync.refresh', 'sync.refresh_status', 'sync.context',
      'pipeline.focus', 'pipeline.status', 'folders.status',
      'compose.reply_context', 'compose.check',
      'backup.schedule.get', 'backup.schedule.set', 'backup.run_now',
      'backup.cancel', 'backup.stop', 'backup.schedule.status',
      'backup.attach_access', 'backup.access_status', 'backup.context', 'backup.surface_retire',
    ]);
    expect([...handle.matchAll(/route_request\(state, req\)/g)]).toHaveLength(3);
    const ordinary = handle.slice(exempt.index + exempt[0].length);
    const injection = ordinary.indexOf('oauth_tokens::inject(');
    const refusal = /if let Some\(message\) = refusal \{\s*return RpcResponse::error\([^;]+;\s*\}/.exec(ordinary);
    expect(injection).toBeGreaterThanOrEqual(0);
    expect(refusal).not.toBeNull();
    expect(injection).toBeLessThan(refusal.index);
    const routes = [...ordinary.matchAll(/route_request\(state, req\)/g)];
    expect(routes).toHaveLength(2);
    for (const route of routes) expect(refusal.index + refusal[0].length).toBeLessThan(route.index);
    expect(ordinary).toMatch(/oauth_tokens::note_refusal\(/);
  });

  it('refreshes inside the margin the app used, one refresh per account at a time', () => {
    expect(tokens).toMatch(/REFRESH_MARGIN_MS: i64 = 5 \* 60 \* 1000/);
    expect(tokens).toMatch(/fn flight\(/);
  });

  it('retired renderer token writer RPCs have no public registration', () => {
    const transport = read('src/services/transport.js');
    const demo = read('src/demo/backend.js');
    const routes = oauth2.slice(0, oauth2.indexOf('/// Test seam'));
    for (const name of ['oauth2.take_refreshed', 'oauth2.credentials_changed']) {
      expect(routes, name).not.toContain(`"${name}"`);
      expect(transport, name).not.toContain(`'${name}'`);
      expect(demo, name).not.toContain(`'${name}'`);
    }
  });

  it('announces a refresh with the account id and nothing else', () => {
    expect(tokens).toMatch(/events\.emit\(REFRESHED_EVENT, json!\(\{ "accountId": account_id \}\)\)/);
  });
});
