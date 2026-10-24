// Slice 7.1 owns pending state only. Worker/manager cutover belongs to 7.2/7.3.
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DAEMON_OWNED } from '../../src/services/transport.js';
import { createDemoBackend } from '../../src/demo/backend.js';

it('registers only implemented bulk controls in daemon transport and router', () => {
  const router = readFileSync('src-daemon/src/handlers/bulk.rs', 'utf8');
  const server = readFileSync('src-daemon/src/server.rs', 'utf8');
  const modules = readFileSync('src-daemon/src/handlers/mod.rs', 'utf8');
  for (const command of ['bulk.status', 'bulk.discard']) {
    expect(DAEMON_OWNED.has(command), command).toBe(true);
    expect(router).toContain(`"${command}"`);
  }
  for (const command of ['bulk.start', 'bulk.resume', 'bulk.cancel']) {
    expect(DAEMON_OWNED.has(command), command).toBe(false);
    expect(router).not.toContain(`"${command}"`);
  }
  expect(server).toContain('crate::handlers::bulk::route(');
  expect(modules).toContain('pub(crate) mod bulk;');
});

it('the demo retains exact pending identities until matching discard', async () => {
  const demo = createDemoBackend();
  const pending = { id: 'old', type: 'delete', accountId: 'a', mailbox: 'INBOX', totalUids: ['a:Work:Clients:1', 'b:Sent:2'], completedUids: ['a:Work:Clients:1'], status: 'deleting', currentPhase: 'delete' };
  await demo.invoke('save_pending_operation', { operation: pending });
  expect(await demo.invoke('bulk.status')).toEqual({ active: null, pending: {
    id: 'old', type: 'delete', status: 'awaitingResume', currentPhase: 'delete', total: 2, completed: 1, remaining: 1, errors: 0, skipped: 0, skippedLocal: 0, result: null, lastError: null,
  } });
  await expect(demo.invoke('bulk.discard', { operationId: 'new' })).rejects.toThrow('errors.bulkStale');
  expect(await demo.invoke('read_pending_operation')).toEqual(pending);
  await expect(demo.invoke('bulk.discard', { operationId: 'old' })).resolves.toBeNull();
  expect(await demo.invoke('bulk.status')).toEqual({ active: null, pending: null });
});

it('the demo preserves unknown-version and malformed evidence', async () => {
  for (const operation of [{ schemaVersion: 99, id: 'future' }, { schemaVersion: 1, id: 'broken' }]) {
    const demo = createDemoBackend();
    await demo.invoke('save_pending_operation', { operation });
    await expect(demo.invoke('bulk.status')).rejects.toThrow(/errors\.bulkPending/);
    await expect(demo.invoke('bulk.discard', { operationId: operation.id })).rejects.toThrow(/errors\.bulkPending/);
    await expect(demo.invoke('save_pending_operation', { operation: {} })).rejects.toThrow('errors.bulkOwned');
    await expect(demo.invoke('clear_pending_operation')).rejects.toThrow('errors.bulkOwned');
    expect(await demo.invoke('read_pending_operation')).toEqual(operation);
  }
});

it('every bulk service error is translated in all nine locales', () => {
  const source = readFileSync('src-core/src/bulk.rs', 'utf8') + readFileSync('src-daemon/src/handlers/bulk.rs', 'utf8');
  const keys = [...new Set([...source.matchAll(/"(errors\.[A-Za-z]+)"/g)].map(match => match[1]))];
  expect(keys.length).toBeGreaterThan(5);
  for (const locale of ['en', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'zh-Hans']) {
    const catalog = JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8'));
    for (const key of keys) {
      expect(catalog[key]?.trim(), `${locale}: ${key}`).toBeTruthy();
      expect(catalog[key], `${locale}: ${key}`).not.toContain('\u2014');
    }
  }
  expect(source).not.toContain('E_BULK_');
});
