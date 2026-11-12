import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registryRow, replyBudget, rustNonTestCode } from './helpers/rustSources.js';
const read = path => readFileSync(path, 'utf8');
it('exposes only the read-only compose contracts and leaves production callers current', () => {
  const transport = read('src/services/transport.js');
  const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'));
  const handler = rustNonTestCode(read('src-daemon/src/handlers/compose_prep.rs'));
  const server = read('src-daemon/src/server.rs');
  for (const method of ['compose.reply_context', 'compose.check']) {
    expect(owned).toContain(`'${method}'`);
    expect(handler).toContain(`"${method}"`);
    expect(read('src/demo/backend.js')).toContain(`'${method}'`);
    expect(replyBudget(method), method).toBe(30);
    // The method table: a person waits on it (holds the index back) and it
    // routes before credential injection.
    expect(registryRow(method), method).toMatchObject({ foreground: true, strict: true, domain: 'ComposePrep' });
  }
  expect(server).toContain('crate::handlers::compose_prep::route(');
  expect(handler).toContain('spawn_blocking');
  expect(handler).not.toMatch(/oauth_tokens|refresh|keychain|vault_files|smtp::|scheduled::|tracing::|println!/);
  for (const file of ['src/components/ComposeModal.jsx','src/App.jsx','src/utils/mailto.js','src/services/composeSend.js']) expect(read(file)).not.toMatch(/compose\.(reply_context|check)/);
});

it('pins the immutable remotely captured corpus bytes', () => {
  expect(createHash('sha256').update(readFileSync('src-core/tests/fixtures/compose-prep-cases.json')).digest('hex')).toBe('049547ee62bd9d8bd95938a94c6d61d4df8a4ed3ca6acc7e3d535ab7b61de9c4');
});

it('dispatches read-only compose before credential injection and retains its budget', () => {
  const server=read('src-daemon/src/server.rs');
  const entry=server.slice(server.indexOf('async fn handle_request('),server.indexOf('fn jmap_refusal_log_line'));
  expect(entry.indexOf('crate::rpc_registry::is_strict(&method)')).toBeGreaterThanOrEqual(0);
  expect(entry.indexOf('crate::rpc_registry::is_strict(&method)')).toBeLessThan(entry.indexOf('oauth_tokens::inject'));
  for (const method of ['compose.reply_context', 'compose.check']) expect(registryRow(method).strict, method).toBe(true);
  expect(entry).toMatch(/return route_request\(state, req\)\.await/);
  for (const method of ['compose.reply_context', 'compose.check']) expect(replyBudget(method), method).toBe(30);
  for (const locale of ['en','de','es','fr','it','pt-BR','ja','ko','zh-Hans']) {
    expect(JSON.parse(read(`src/i18n/locales/${locale}.json`))['compose.preparationUnavailable']).toBeTruthy();
  }
});
