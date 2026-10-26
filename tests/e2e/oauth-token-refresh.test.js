/**
 * The token-refresh hand-test checklist (docs/plans/2026-10-20-token-refresh-
 * hand-tests.md), steps 1, 2 and 5, through the whole app against mock servers
 * (wdio.oauth.conf.js): the daemon refreshes against the mock token endpoint,
 * the mock IMAP and SMTP servers accept only a token it issued.
 *
 * The seeded account's access token is not one the mock issued and its expiry
 * is an hour past, so the first server use must refresh. The tests run in
 * order on one app: the revoke comes last.
 *
 * Not provable here: Google's consent screen and revoke page, the real client
 * ids and scopes, the macOS keychain. The Reconnect click itself is the
 * interactive sign-in; the test writes the record that sign-in would save.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, runBackupAndWait, switchToFolder } from './helpers.js';
import { appDataDir } from './mockImap.js';
import { posts, issued, revoke, signIn, authLog, GOOGLE_SCOPE, THUNDERBIRD_CLIENT_ID } from './mockOAuth.js';

const origin = () => process.env.E2E_MOCK_OAUTH_ORIGIN;
const account = () => browser.mockAccounts[0];
const credentialsPath = () => join(appDataDir(browser.testDataDir), 'test-credentials.json');
const stored = () => JSON.parse(JSON.parse(readFileSync(credentialsPath(), 'utf8'))[account().id]);

function rpc(method, params) {
  return browser.executeAsync((m, p, done) => {
    window.__TAURI__.core.invoke('daemon_rpc', { method: m, params: p })
      .then(done)
      .catch((e) => done({ __error: String((e && e.message) || e) }));
  }, method, params);
}

async function waitUntil(check, what, timeout = 30_000, describe = async () => '') {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} ${await describe()}`);
    await browser.pause(200);
  }
}

function daemonLog() {
  const dir = join(appDataDir(browser.testDataDir), 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter((f) => f.startsWith('daemon.log')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

/** Every token the mock issued that the daemon's log holds. Must be none. */
async function leakedTokens() {
  const log = daemonLog();
  return (await issued(origin())).filter((t) => log.includes(t)).map((t) => `${t.slice(0, 12)}...`);
}

const store = () => browser.execute(() => {
  const s = window.__MAIL_STORE__?.getState?.();
  // No `error` key: the WebDriver bridge reads a returned `error` as a failure.
  return s ? { errorType: s.connectionErrorType, code: s.connectionErrorCode, status: s.connectionStatus, text: s.connectionError } : null;
});

/** The sidebar's "Sign-in needed" for an OAuth account (Sidebar.jsx `needsSignIn`). */
const needsSignIn = (s) => !!s && (s.errorType === 'oauthExpired' || (s.errorType === 'serverError' && s.code === 'auth'));

describe('OAuth2 token refresh against mock servers', () => {
  before(async () => {
    await waitForApp();
  });

  // Checklist 1.
  it('refreshes an expired token once for INBOX, send and backup, and the app saves the pair', async () => {
    await waitForEmails();
    await waitUntil(async () => (await posts(origin())).length >= 1, 'the first refresh');

    const sent = await rpc('smtp_send_email', {
      account: account(),
      email: { to: 'partner@example.com', subject: 'OAuth e2e', text: 'sent with a refreshed token' },
    });
    assert.ok(!sent?.__error, `send: ${sent?.__error}`);
    const backup = await runBackupAndWait({ accountId: account().id, accountJson: JSON.stringify(account()), backupPath: null, skipFolders: 0 });
    assert.ok(!backup.cancelled && !backup.error_message, `backup: ${JSON.stringify(backup)}`);

    const all = await posts(origin());
    assert.equal(all.length, 1, `one refresh for every use: ${JSON.stringify(all)}`);
    assert.deepEqual(all[0], { grantType: 'refresh_token', clientId: THUNDERBIRD_CLIENT_ID, scope: GOOGLE_SCOPE, status: 200 });
    assert.ok((await authLog(origin())).every((a) => a.accepted), 'the stale seeded token never reached a server');

    // The app saved the pair the daemon refreshed, over the stored record.
    await waitUntil(() => stored().oauth2AccessToken !== account().oauth2AccessToken, 'the app to save the refreshed pair');
    assert.equal(stored().oauth2RefreshToken, account().oauth2RefreshToken, 'Google keeps the refresh token');
    assert.ok(stored().oauth2ExpiresAt > Date.now());
    assert.deepEqual(await leakedTokens(), []);
  });

  it('native metadata update probes current stored tokens and returns only metadata', async()=>{
    const before=stored();const count=(await posts(origin())).length;
    const result=await browser.executeAsync((id,done)=>{
      window.__MAIL_STORE__.getState().updateAccount(id,{displayName:'S2.3 native account'}).then(a=>done({id:a.id,name:a.displayName,secretFree:!['password','oauth2AccessToken','oauth2RefreshToken'].some(k=>Object.hasOwn(a,k))})).catch(e=>done({failed:String(e?.message||e)}));
    },account().id);
    assert.ok(!result.failed,`native metadata update: ${result.failed}`);assert.equal(result.name,'S2.3 native account');assert.equal(result.secretFree,true);
    const after=stored();assert.ok(after.oauth2AccessToken===before.oauth2AccessToken&&after.oauth2RefreshToken===before.oauth2RefreshToken,'metadata save preserves the current pair');
    assert.equal((await posts(origin())).length,count);assert.ok((await authLog(origin())).every(a=>a.accepted));
  });

  // Checklist 5.
  it('answers the keychain code, never "Missing accessToken", when the store cannot be read', async () => {
    const saved = readFileSync(credentialsPath(), 'utf8');
    writeFileSync(credentialsPath(), '{ not json');
    let answer;
    try {
      answer = await rpc('graph_list_folders', { accountId: 'not-cached-graph-account', accountEmail: 'leia@outlook.test' });
    } finally {
      writeFileSync(credentialsPath(), saved);
    }
    assert.match(String(answer?.__error), /E_OAUTH_KEYCHAIN_UNAVAILABLE/);
    assert.doesNotMatch(String(answer?.__error), /Missing accessToken/);
  });

  // Checklist 2.
  it('shows the sign-in state once the grant is revoked, and a new sign-in works without a restart', async () => {
    await revoke(origin(), stored().oauth2RefreshToken);
    // Gmail keeps a session already signed in: the revoke shows on the next
    // connection. End the pooled ones, as an idle timeout would.
    await rpc('imap_disconnect', { account: account() });
    const before = (await posts(origin())).length;

    await switchToFolder(account().email, 'Sent');
    // The load fails with the refused sign-in: its rejection is expected.
    await browser.execute(() => { window.__MAIL_STORE__?.getState?.().loadEmails?.()?.catch?.(() => {}); });
    await waitUntil(async () => needsSignIn(await store()), 'the sign-in-needed state', 30_000, async () => JSON.stringify(await store()));
    const refused = await rpc('imap_get_mailboxes', { account: account() });
    assert.match(String(refused?.__error), /XOAUTH2 auth failed/);
    for (let i = 0; i < 10; i++) await rpc('imap_get_mailboxes', { account: account() });
    assert.ok((await posts(origin())).length - before <= 1, 'at most one token request in the cooldown');

    // Reconnect uses the actual native workflow with the submitted lower-expiry
    // pair, independently of the refused old grant/cache/refresh flight.
    const grant = await signIn(origin(), { clientId: THUNDERBIRD_CLIENT_ID, scope: GOOGLE_SCOPE, expiresIn: 600 });
    const beforeReplacement=(await posts(origin())).length;
    const replaced=await browser.executeAsync((id,fields,done)=>{
      window.__MAIL_STORE__.getState().updateAccount(id,fields).then(a=>done({id:a.id,secretFree:!['password','oauth2AccessToken','oauth2RefreshToken'].some(k=>Object.hasOwn(a,k))})).catch(e=>done({failed:String(e?.message||e)}));
    },account().id,{oauth2AccessToken:grant.accessToken,oauth2RefreshToken:grant.refreshToken,oauth2ExpiresAt:grant.expiresAt,oauth2ClientId:THUNDERBIRD_CLIENT_ID});
    assert.ok(!replaced.failed,`native replacement: ${replaced.failed}`);assert.equal(replaced.id,account().id);assert.equal(replaced.secretFree,true);
    assert.ok(stored().oauth2AccessToken===grant.accessToken&&stored().oauth2RefreshToken===grant.refreshToken,'the submitted pair was saved together');
    assert.equal((await posts(origin())).length,beforeReplacement,'replacement must not refresh the refused old grant');

    const after = await rpc('imap_get_mailboxes', { account: account() });
    assert.ok(!after?.__error, `the next request works with the new sign-in: ${after?.__error}`);
    await switchToFolder(account().email, 'INBOX');
    await waitUntil(async () => !needsSignIn(await store()), 'the sign-in state to clear', 30_000, async () => JSON.stringify(await store()));
    assert.deepEqual(await leakedTokens(), []);
  });
});
