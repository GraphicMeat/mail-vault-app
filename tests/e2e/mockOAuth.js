/**
 * Mock OAuth2 token endpoint for the e2e harness (wdio.oauth.conf.js).
 *
 * The same implementation the Rust tests use (`src-mock-imap/src/oauth.rs`),
 * run as the `mock-oauth-server` binary. The app's debug build posts its token
 * refreshes here (`MAILVAULT_GOOGLE_TOKEN_ENDPOINT` / `_MS_`, honoured only by
 * debug builds and only for a loopback URL); the mock IMAP and SMTP servers
 * (`tokenCheckOrigin`) and the Graph mock (`E2E_MOCK_OAUTH_ORIGIN`) accept a
 * sign-in only with a token it issued that has not expired.
 *
 * Its controls answer counts and states, never a token, except `signIn` (the
 * seed's own) and `issued` (every token, for a spec's leak scan).
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SERVER_BIN = join(
  REPO_ROOT,
  process.platform === 'win32' ? 'target/debug/mock-oauth-server.exe' : 'target/debug/mock-oauth-server'
);

/** Google's mail scope: what the daemon posts for a Gmail refresh. */
export const GOOGLE_SCOPE = 'https://mail.google.com/';
/** Thunderbird's public Google client id: an unstamped account refreshes with it. */
export const THUNDERBIRD_CLIENT_ID = '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com';

export function buildMockOAuthServer() {
  execFileSync('cargo', ['build', '-p', 'mock-imap', '--bin', 'mock-oauth-server'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (!existsSync(SERVER_BIN)) throw new Error(`mock-oauth-server missing after build: ${SERVER_BIN}`);
}

/** Start it on a random loopback port. Resolves `{ origin, stop }`. */
export function startMockOAuth() {
  return new Promise((res, rej) => {
    const proc = spawn(SERVER_BIN, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); rej(new Error('mock-oauth-server did not report a port')); }, 10_000);
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (!out.includes('}')) return;
      clearTimeout(timer);
      const { port } = JSON.parse(out.split('\n')[0]);
      res({ origin: `http://127.0.0.1:${port}`, stop: () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } } });
    });
    proc.on('error', (e) => { clearTimeout(timer); rej(e); });
  });
}

async function call(origin, method, path, body) {
  const r = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`mock oauth ${path}: ${r.status}`);
  return r.json();
}

/** A user signs in: `{ refreshToken, accessToken, expiresAt }`. */
export const signIn = (origin, spec) => call(origin, 'POST', '/__mock/sign-in', spec);
/** The user revokes the app. */
export const revoke = (origin, refreshToken) => call(origin, 'POST', '/__mock/revoke', { refreshToken });
/** Token POSTs so far: `[{ grantType, clientId, scope, status }]`, no tokens. */
export const posts = (origin) => call(origin, 'GET', '/__mock/posts');
/** Sign-ins the mail servers checked: `[{ service, user, accepted }]`. */
export const authLog = (origin) => call(origin, 'GET', '/__mock/auth-log');
/** Every token issued, for a scan of what the app and daemon wrote. */
export const issued = (origin) => call(origin, 'GET', '/__mock/issued');
