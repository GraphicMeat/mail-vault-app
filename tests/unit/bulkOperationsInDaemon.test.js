// The native worker owns every bulk action and its controls.
import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DAEMON_OWNED } from '../../src/services/transport.js';
import { createDemoBackend } from '../../src/demo/backend.js';

it('registers implemented bulk controls in daemon transport and router', () => {
  const router = readFileSync('src-daemon/src/handlers/bulk.rs', 'utf8');
  const server = readFileSync('src-daemon/src/server.rs', 'utf8');
  const modules = readFileSync('src-daemon/src/handlers/mod.rs', 'utf8');
  for (const command of ['bulk.start', 'bulk.resume', 'bulk.status', 'bulk.cancel', 'bulk.discard']) {
    expect(DAEMON_OWNED.has(command), command).toBe(true);
    expect(router).toContain(`"${command}"`);
  }
  const shell = readFileSync('src-tauri/src/main.rs', 'utf8');
  const forwarding = shell.indexOf('bulk::forward(');
  const fastPath = shell.indexOf('let fast_token', shell.indexOf('async fn daemon_rpc('));
  expect(forwarding).toBeGreaterThan(shell.indexOf('async fn daemon_rpc('));
  expect(forwarding).toBeLessThan(fastPath);
  const native = readFileSync('src-tauri/src/bulk.rs', 'utf8');
  expect(native).toMatch(/set_root\(&mut params,\s*None\)/);
  expect(native).toContain('reconcile_after_channel_change');
  // Admission fencing extends existing bulk.status; it is not a new RPC.
  expect(native).toContain('fenceUnstarted');
  expect(router).toContain('fenceUnstarted');
  expect(readFileSync('src/demo/backend.js', 'utf8')).toContain('fenceUnstarted');

  const oldManager = readFileSync('src/services/BulkOperationManager.js', 'utf8');
  expect(oldManager).toContain("'bulk.start'");
  for (const command of ['archive_emails', 'bulkDeleteEmails', 'verifyArchivedEmails', 'backupCopyUids', 'savePendingOperation', 'clearPendingOperation']) expect(oldManager).not.toContain(command);
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
    const demo = createDemoBackend({ initialPendingOperation: operation });
    await expect(demo.invoke('bulk.status')).rejects.toThrow(/errors\.bulkPending/);
    await expect(demo.invoke('bulk.discard', { operationId: operation.id })).rejects.toThrow(/errors\.bulkPending/);
    await expect(demo.invoke('save_pending_operation', { operation: {} })).rejects.toThrow('errors.bulkOwned');
    await expect(demo.invoke('clear_pending_operation')).rejects.toThrow('errors.bulkOwned');
    expect(await demo.invoke('read_pending_operation')).toEqual(operation);
  }
});

it('every bulk service error is translated in all nine locales', () => {
  const source = ['src-core/src/bulk.rs', 'src-core/src/bulk_worker.rs', 'src-daemon/src/bulk_worker.rs', 'src-daemon/src/handlers/bulk.rs', 'src-tauri/src/bulk.rs'].map(path => readFileSync(path, 'utf8')).join('\n');
  const keys = [...new Set([...source.matchAll(/"(errors\.[A-Za-z_.]+)"/g)].map(match => match[1]))];
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

it('the demo refuses malformed or inconsistent versioned intent without discarding evidence', async () => {
  const valid = {
    operation: 'delete', scope: { accountId: 'a', mailbox: 'INBOX', keys: [7] },
    groups: [{ accountId: 'a', mailbox: 'INBOX', uids: [7] }], refused: [], skippedLocal: 0,
  };
  const intents = [
    {},
    { ...valid, scope: {} },
    { ...valid, groups: [{ accountId: 'a', mailbox: 'INBOX', uids: [4294967296] }] },
    { ...valid, skippedLocal: -1 },
    { ...valid, operation: 'archive' },
    { ...valid, groups: [{ accountId: 'a', mailbox: 'Sent', uids: [7] }] },
  ];
  for (const intent of intents) {
    const operation = {
      schemaVersion: 1, id: 'damaged', type: 'delete', accountId: 'a', mailbox: 'INBOX',
      totalUids: ['a:INBOX:7'], completedUids: [], status: 'starting', currentPhase: 'delete', intent,
    };
    const demo = createDemoBackend({ initialPendingOperation: operation });
    await expect(demo.invoke('bulk.discard', { operationId: 'damaged' })).rejects.toThrow('errors.bulkPendingInvalid');
    await expect(demo.invoke('bulk.status')).rejects.toThrow('errors.bulkPendingInvalid');
    expect(await demo.invoke('read_pending_operation')).toEqual(operation);
  }
});

it('the demo accepts consistent versioned grouping and opaque purge selections', async () => {
  for (const type of ['delete', 'delete_everywhere']) {
    const keys = type === 'delete' ? ['a:Work:Clients:7'] : [7, 'b:Sent:8'];
    const intent = {
      operation: type, scope: { keys }, refused: [], skippedLocal: 0,
      groups: type === 'delete' ? [{ accountId: 'a', mailbox: 'Work:Clients', uids: [7] }] : [],
    };
    const operation = {
      schemaVersion: 1, id: 'valid', type, totalUids: keys, completedUids: [], status: 'starting', intent,
    };
    const demo = createDemoBackend({ initialPendingOperation: operation });
    expect((await demo.invoke('bulk.status')).pending.remaining).toBe(keys.length);
    await expect(demo.invoke('bulk.discard', { operationId: 'valid' })).resolves.toBeNull();
    expect(await demo.invoke('read_pending_operation')).toBeNull();
  }
});

it('demo kickoff returns before matching cancellation drains once', async () => {
  vi.useFakeTimers();
  try {
    const demo=createDemoBackend();const events=[];demo.on('bulk-progress',({payload})=>events.push(payload));
    const reply=await demo.invoke('bulk.start',{operationId:'demo-worker',type:'archive',scope:{keys:[]}});
    expect(reply.status).toBe('starting');
    await expect(demo.invoke('bulk.cancel',{operationId:'foreign'})).rejects.toThrow('errors.bulkStale');
    await demo.invoke('bulk.cancel',{operationId:'demo-worker'});
    expect((await demo.invoke('bulk.status')).active.status).toBe('cancelling');
    expect(events.filter(e=>e.finished)).toHaveLength(0);
    await vi.runAllTimersAsync();
    expect(events.filter(e=>e.finished)).toHaveLength(1);
    expect(events.at(-1).operation.status).toBe('cancelled');
    expect((await demo.invoke('bulk.status')).active).toBeNull();
  } finally {vi.useRealTimers();}
});

it('demo status fences an unseen attempt before a late kickoff', async () => {
  const demo=createDemoBackend();const status=await demo.invoke('bulk.status',{operationId:'late',attemptId:'unseen',fenceUnstarted:true});
  expect(status.admission).toEqual({operationId:'late',attemptId:'unseen',state:'fenced'});
  await expect(demo.invoke('bulk.start',{operationId:'late',attemptId:'unseen',type:'archive',scope:{keys:[]}})).rejects.toThrow('errors.bulkStale');
  expect((await demo.invoke('bulk.status')).active).toBeNull();
});

it('demo legacy saves cannot create native versioned authority', async () => {
  for (const previous of [null, { id: 'legacy', type: 'delete', totalUids: [7], completedUids: [], status: 'deleting' }]) {
    const demo = createDemoBackend();
    if (previous) await demo.invoke('save_pending_operation', { operation: previous });
    for (const schemaVersion of [1, 99, null, 'malformed']) {
      await expect(demo.invoke('save_pending_operation', { operation: { schemaVersion, id: 'supplied', intent: {}, worker: {} } })).rejects.toThrow('errors.bulkOwned');
      expect(await demo.invoke('read_pending_operation')).toEqual(previous);
    }
  }
});

it('App mounts the tested live pending presentation even before pending work exists', () => {
  const app = readFileSync('src/App.jsx', 'utf8');
  expect(app).toContain('<BulkPendingOperationBanner pending={pendingOperation} onPendingChange={setPendingOperation} />');
});
