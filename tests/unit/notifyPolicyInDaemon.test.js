/**
 * Phase 1 row 9: whether a new-mail banner is shown is decided by the daemon
 * (`notify.decide`: src-daemon/src/handlers/notify.rs over
 * src-core/src/notify_policy.rs and the settings document). notify() in
 * stores/focusStore.js asks it, logs the answer and renders the banner; the
 * app holds no copy of the rules. Reads the sources, like learningInDaemon.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const transport = readFileSync('src/services/transport.js', 'utf8');
const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'), transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
const handler = readFileSync('src-daemon/src/handlers/notify.rs', 'utf8');
const core = readFileSync('src-core/src/notify_policy.rs', 'utf8');
const server = readFileSync('src-daemon/src/server.rs', 'utf8');
const handlersMod = readFileSync('src-daemon/src/handlers/mod.rs', 'utf8');
const demo = readFileSync('src/demo/backend.js', 'utf8');
const api = readFileSync('src/services/api.js', 'utf8');
const focusStore = readFileSync('src/stores/focusStore.js', 'utf8');
const settingsPanel = readFileSync('src/components/settings/NotificationSettings.jsx', 'utf8');
const en = JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8'));

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...sourceFiles(path));
    } else if (/\.(js|jsx)$/.test(name) && !/\.test\.jsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

// The reason codes the Rust policy answers, read from its constants.
const REASONS = [...core.matchAll(/pub const [A-Z_]+: &str = "([a-z-]+)";/g)].map(m => m[1]);

describe('the notification policy lives in the daemon', () => {
  it('notify.decide is daemon-owned, routed by handlers/notify.rs and stubbed in the demo', () => {
    expect(owned).toContain("'notify.decide'");
    expect(handler).toContain('"notify.decide"');
    expect(demo).toContain("'notify.decide'");
  });

  it('the daemon chains the notify router', () => {
    expect(handlersMod).toMatch(/pub\(crate\) mod notify;/);
    expect(server).toContain('crate::handlers::notify::route(');
  });

  it('notify() asks the daemon through api.js', () => {
    expect(api).toContain("tauriInvoke('notify.decide'");
    expect(focusStore).toMatch(/await notifyDecision\(/);
  });

  it('the JS policy is gone and nothing imports it', () => {
    expect(existsSync('src/utils/notificationPolicy.js')).toBe(false);
    const hits = sourceFiles('src').filter(f => /notificationPolicy|\bshouldNotify\b/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('every reason the daemon answers has a label in the decision log', () => {
    expect(REASONS).toEqual([
      'focus-hold', 'notifications-off', 'priority-allowlist', 'quiet-hours',
      'view-muted', 'account-muted', 'folder-not-watched', 'delivered-default',
    ]);
    for (const reason of [...REASONS, 'policy-unavailable']) {
      const key = settingsPanel.match(new RegExp(`'${reason}': '(notifyPolicy\\.reason\\.[A-Za-z]+)'`))?.[1];
      expect(key, reason).toBeTruthy();
      expect(en[key], key).toBeTruthy();
    }
  });

  it("the daemon's one error is a catalog key", () => {
    for (const [, key] of handler.matchAll(/RpcResponse::error\(id, ipc::[A-Z_]+, "([^"]+)"\)/g)) {
      expect(en[key], key).toBeTruthy();
    }
  });
});
