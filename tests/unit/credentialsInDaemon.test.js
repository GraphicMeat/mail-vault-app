import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDemoBackend } from '../../src/demo/backend.js';

const read = path => readFileSync(path, 'utf8');
const RPCS = ['credentials.get', 'credentials.save', 'credentials.update', 'credentials.delete'];
const transport = read('src/services/transport.js');
const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'), transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
const handler = read('src-daemon/src/handlers/credentials.rs');
const shell = read('src-tauri/src/main.rs');
const locales = ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'zh-Hans'];

describe('staged native credential capability', () => {
  it.each(RPCS)('%s is registered in transport, native handler and shell budget', rpc => {
    expect(owned).toContain(`'${rpc}'`);
    expect(handler).toContain(`"${rpc}"`);
    const budget = shell.slice(shell.indexOf('fn reply_timeout('), shell.indexOf('fn reply_timeout(') + 11000);
    expect(budget).toContain(`"${rpc}"`);
  });

  it('chains the actual native router and shares the split writer', () => {
    expect(read('src-daemon/src/handlers/mod.rs')).toContain('pub(crate) mod credentials;');
    expect(read('src-daemon/src/server.rs')).toContain('crate::handlers::credentials::route(');
    expect(shell).toMatch(/write_split_secret\(\s*&mut Keyring/);
    expect(read('src-daemon/src/credentials.rs')).toMatch(/write_split_secret\(\s*&mut Keyring/);
  });

  it('demo credential reads delegate to its existing synthetic credential read', async () => {
    const demo = createDemoBackend();
    expect(await demo.invoke('daemon_rpc', { method: 'credentials.get', params: {} }))
      .toEqual(await demo.invoke('get_credentials'));
  });

  it.each(RPCS.slice(1))('demo %s explicitly refuses mutation', async rpc => {
    const demo = createDemoBackend();
    await expect(demo.invoke('daemon_rpc', { method: rpc, params: {} })).rejects.toThrow();
    expect(await demo.invoke('credentials.get')).toEqual(await demo.invoke('get_credentials'));
  });

  it.each(locales)('%s supplies all native credential error catalog keys', locale => {
    const catalog = JSON.parse(read(`src/i18n/locales/${locale}.json`));
    for (const key of ['errors.keychainUnavailable', 'errors.keychainWriteFailed', 'errors.keychainBusy', 'errors.credentialsInvalid']) {
      expect(catalog[key], key).toBeTypeOf('string');
      expect(catalog[key].length).toBeGreaterThan(10);
    }
    if (locale === 'en') expect(catalog['errors.keychainWriteFailed']).not.toMatch(/unchanged|nothing was saved/i);
  });
});
