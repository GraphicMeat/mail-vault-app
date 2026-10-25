import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(path, 'utf8');
it('exposes only the read-only compose contracts and leaves production callers current', () => {
  const transport = read('src/services/transport.js');
  const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'));
  const handler = read('src-daemon/src/handlers/compose_prep.rs').split('#[cfg(test)]')[0];
  const server = read('src-daemon/src/server.rs');
  for (const method of ['compose.reply_context', 'compose.check']) {
    expect(owned).toContain(`'${method}'`);
    expect(handler).toContain(`"${method}"`);
    expect(read('src/demo/backend.js')).toContain(`'${method}'`);
    expect(read('src-tauri/src/main.rs')).toContain(`"${method}"`);
    expect(read('src-daemon/src/search_index.rs')).toContain(`"${method}"`);
  }
  expect(server).toContain('crate::handlers::compose_prep::route(');
  expect(handler).toContain('spawn_blocking');
  expect(handler).not.toMatch(/oauth_tokens|refresh|keychain|vault_files|smtp::|scheduled::|tracing::|println!/);
  for (const file of ['src/components/ComposeModal.jsx','src/App.jsx','src/utils/mailto.js','src/services/composeSend.js']) expect(read(file)).not.toMatch(/compose\.(reply_context|check)/);
});

it('pins the immutable remotely captured corpus bytes', () => {
  expect(createHash('sha256').update(readFileSync('src-core/tests/fixtures/compose-prep-cases.json')).digest('hex')).toBe('049547ee62bd9d8bd95938a94c6d61d4df8a4ed3ca6acc7e3d535ab7b61de9c4');
});
