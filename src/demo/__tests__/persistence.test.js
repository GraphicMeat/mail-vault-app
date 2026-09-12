import { describe, expect, it } from 'vitest';
import { createDemoBackend } from '../backend.js';
import { bindDemoSettingsStore, bindDemoThemeStore, demoBackend } from '../runtime.js';
import {
  createMemoryStorageAdapter,
  DemoWorkspaceStorage,
  DEMO_STORAGE_TTL_MS,
} from '../storage.js';

describe('browser demo workspace persistence', () => {
  it('keeps a fixed seven-day expiry while replacing the payload', async () => {
    let clock = 10_000;
    const adapter = createMemoryStorageAdapter();
    const storage = new DemoWorkspaceStorage({ adapter, now: () => clock });
    const first = await storage.write({ version: 'first' });
    expect(first).toMatchObject({ ok: true, createdAt: clock, expiresAt: clock + DEMO_STORAGE_TTL_MS });

    clock += 2_000;
    const second = await storage.write({ version: 'second' });
    expect(second).toMatchObject({ ok: true, createdAt: first.createdAt, expiresAt: first.expiresAt });
    expect((await storage.read()).state).toEqual({ version: 'second' });

    clock = first.expiresAt - 1;
    await expect(storage.read()).resolves.toMatchObject({ status: 'restored' });
    clock = first.expiresAt;
    await expect(storage.read()).resolves.toMatchObject({ status: 'expired', state: null });
    await expect(storage.write({ version: 'must-not-revive' })).resolves.toMatchObject({ ok: true, status: 'saved' });
    // A new write after expiry is a new workspace only after expiry cleanup;
    // it receives a new timestamp and never revives the old deadline.
    expect(adapter.value.expiresAt).toBe(clock + DEMO_STORAGE_TTL_MS);
  });

  it('rotates the generation when expiry invalidates a record so stale tabs cannot revive it', async () => {
    let clock = 10_000;
    const adapter = createMemoryStorageAdapter();
    const first = new DemoWorkspaceStorage({ adapter, now: () => clock });
    const second = new DemoWorkspaceStorage({ adapter, now: () => clock });
    const saved = await first.write({ value: 'before expiry' });
    const observed = await second.read();
    clock = saved.expiresAt;

    await expect(first.read()).resolves.toMatchObject({ status: 'expired', generation: expect.any(String) });
    expect(adapter.generation.generation).not.toBe(observed.generation);
    await expect(second.write({ value: 'stale resurrection' }, { generation: observed.generation }))
      .resolves.toMatchObject({ ok: false, status: 'stale' });
    expect(adapter.value).toBeNull();
  });

  it('migrates a generationless legacy record with a guarded first write', async () => {
    let clock = 50_000;
    const payloadJson = JSON.stringify({ legacy: true });
    const adapter = createMemoryStorageAdapter({
      schemaVersion: 1,
      seedVersion: 'demo-300-v1',
      createdAt: clock,
      expiresAt: clock + DEMO_STORAGE_TTL_MS,
      bytes: new TextEncoder().encode(payloadJson).byteLength,
      payloadJson,
    });
    const first = new DemoWorkspaceStorage({ adapter, now: () => clock });
    const second = new DemoWorkspaceStorage({ adapter, now: () => clock });
    const observed = await first.read();
    expect(observed).toMatchObject({ status: 'restored', generation: '' });

    const reset = await second.clear();
    await expect(first.write({ legacy: 'must not return' }, { generation: observed.generation }))
      .resolves.toMatchObject({ ok: false, status: 'stale', generation: reset.generation });

    // A fresh legacy writer can acquire a token while no reset marker exists.
    const freshAdapter = createMemoryStorageAdapter({
      schemaVersion: 1,
      seedVersion: 'demo-300-v1',
      createdAt: clock,
      expiresAt: clock + DEMO_STORAGE_TTL_MS,
      bytes: new TextEncoder().encode(payloadJson).byteLength,
      payloadJson,
    });
    const fresh = new DemoWorkspaceStorage({ adapter: freshAdapter, now: () => clock });
    await fresh.read();
    await expect(fresh.write({ legacy: 'migrated' }, { generation: '' })).resolves.toMatchObject({ ok: true, status: 'saved', generation: expect.any(String) });
  });

  it('does not let a paused expiry cleanup delete a reset replacement', async () => {
    let clock = 100;
    const adapter = createMemoryStorageAdapter();
    const storage = new DemoWorkspaceStorage({ adapter, now: () => clock });
    const seeded = await storage.write({ value: 'expired' });
    clock = seeded.expiresAt;
    const originalInvalidate = adapter.invalidate.bind(adapter);
    let raced = false;
    adapter.invalidate = async (...args) => {
      if (!raced) {
        raced = true;
        const reset = await storage.clear();
        await storage.write({ value: 'replacement' }, { generation: reset.generation });
      }
      return originalInvalidate(...args);
    };

    await expect(storage.read()).resolves.toMatchObject({ state: { value: 'replacement' }, status: 'restored' });
    await expect(storage.read()).resolves.toMatchObject({ state: { value: 'replacement' } });
  });

  it('rejects a write when reset occurs between its read and compare commit', async () => {
    const adapter = createMemoryStorageAdapter();
    const storage = new DemoWorkspaceStorage({ adapter, now: () => 100 });
    const saved = await storage.write({ value: 'old' });
    const originalCompareAndPut = adapter.compareAndPut.bind(adapter);
    let raced = false;
    adapter.compareAndPut = async (...args) => {
      if (!raced) {
        raced = true;
        const reset = await storage.clear();
        await storage.write({ value: 'replacement' }, { generation: reset.generation });
      }
      return originalCompareAndPut(...args);
    };

    await expect(storage.write({ value: 'stale' }, { generation: saved.generation })).resolves.toMatchObject({ ok: false, status: 'stale' });
    await expect(storage.read()).resolves.toMatchObject({ state: { value: 'replacement' } });
  });

  it('keeps a concurrent replacement when an expired legacy record has no token', async () => {
    let clock = 100;
    const adapter = createMemoryStorageAdapter();
    const storage = new DemoWorkspaceStorage({ adapter, now: () => clock });
    const seeded = await storage.write({ value: 'legacy expired' });
    const legacy = adapter.value;
    delete legacy.generation;
    await adapter.put(legacy);
    clock = seeded.expiresAt;
    const originalInvalidate = adapter.invalidate.bind(adapter);
    let raced = false;
    adapter.invalidate = async (...args) => {
      if (!raced) {
        raced = true;
        const reset = await storage.clear();
        await storage.write({ value: 'replacement' }, { generation: reset.generation });
      }
      return originalInvalidate(...args);
    };

    await expect(storage.read()).resolves.toMatchObject({ state: { value: 'replacement' } });
  });

  it('continues in memory when IndexedDB is unavailable or the state exceeds budget', async () => {
    const unavailable = new DemoWorkspaceStorage({ indexedDB: null });
    await expect(unavailable.read()).resolves.toMatchObject({ status: 'unavailable', degraded: true });

    const storage = new DemoWorkspaceStorage({ adapter: createMemoryStorageAdapter(), budgetBytes: 8 });
    await expect(storage.write({ text: 'too large' })).resolves.toMatchObject({ ok: false, status: 'quota' });
  });

  it('drops incompatible and malformed records safely', async () => {
    const adapter = createMemoryStorageAdapter({ schemaVersion: 999, seedVersion: 'old', createdAt: 1, expiresAt: 100_000, bytes: 2, payloadJson: '{}' });
    const storage = new DemoWorkspaceStorage({ adapter, now: () => 10 });
    await expect(storage.read()).resolves.toMatchObject({ status: 'incompatible', state: null });
    await adapter.put({ schemaVersion: 1, seedVersion: 'demo-300-v1', createdAt: 1, expiresAt: 100_000, bytes: 5, payloadJson: '{bad' });
    await expect(storage.read()).resolves.toMatchObject({ status: 'corrupt', state: null });
  });

  it('rejects a stale tab after another tab resets the workspace', async () => {
    const adapter = createMemoryStorageAdapter();
    let clock = 100;
    const first = new DemoWorkspaceStorage({ adapter, now: () => clock });
    const second = new DemoWorkspaceStorage({ adapter, now: () => clock });
    const seeded = await first.write({ folders: ['before reset'] });
    const restored = await second.read();
    expect(restored.generation).toBe(seeded.generation);
    const reset = await first.clear();
    clock += 1;
    await expect(second.write({ folders: ['stale tab edit'] }, { generation: restored.generation })).resolves.toMatchObject({ ok: false, status: 'stale' });
    expect(adapter.generation).toEqual(expect.objectContaining({ generation: reset.generation }));
  });

  it('exports durable edits but never restores a pending operation', async () => {
    const source = createDemoBackend();
    const account = source.snapshot().accounts[0];
    await source.invoke('save_pending_operation', { operation: { type: 'send', body: 'do not replay' } });
    await source.invoke('write_settings_json', { data: JSON.stringify({ language: 'de', custom: true }) });
    await source.invoke('imap_create_mailbox', { accountId: account.id, path: 'Demo folder' });
    const stored = source.exportState();

    const restored = createDemoBackend();
    restored.restoreState(stored);
    await expect(restored.invoke('read_pending_operation')).resolves.toBeNull();
    await expect(restored.invoke('read_settings_json')).resolves.toContain('"language":"de"');
    await expect(restored.invoke('imap_get_mailboxes', { accountId: account.id })).resolves.toMatchObject({ mailboxes: expect.arrayContaining([expect.objectContaining({ path: 'Demo folder' })]) });
    expect(restored.snapshot().messages).toHaveLength(source.snapshot().messages.length);
    const sourceRich = source.snapshot().messages.find(message => message.attachments.length);
    const restoredRich = restored.snapshot().messages.find(message => message.messageId === sourceRich.messageId);
    expect(restoredRich.rawSourceBase64).toBe(sourceRich.rawSourceBase64);
    expect(restoredRich.attachments[0].contentBase64 || restoredRich.attachments[0].content).toBe(sourceRich.attachments[0].contentBase64 || sourceRich.attachments[0].content);
  });

  it('mirrors a hydrated settings-store change before the native debounce elapses', async () => {
    let state = { language: 'en', sidebarLayout: 'stacked' };
    let listener;
    const store = {
      getState: () => state,
      subscribe: callback => { listener = callback; return () => { listener = null; }; },
    };
    bindDemoSettingsStore(store);
    state = { ...state, language: 'ja' };
    listener(state);
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(demoBackend.invoke('read_settings_json')).resolves.toContain('"language":"ja"');
  });

  it('restores permanent-delete tombstones together with unrelated edits', async () => {
    const source = createDemoBackend();
    const baseline = source.snapshot();
    const account = baseline.accounts[0];
    const serverOnly = baseline.messages.find(message => message.accountId === account.id && message.custody === 'server');
    await source.invoke('imap_delete_email', { account, mailbox: serverOnly.mailbox, uid: serverOnly.uid, permanent: true });
    await source.invoke('imap_create_mailbox', { accountId: account.id, path: 'Kept after reload' });
    const stored = source.exportState();
    const restored = createDemoBackend();
    restored.restoreState(stored);
    expect(restored.snapshot().messages.find(message => message.messageId === serverOnly.messageId)).toMatchObject({ serverPresent: false, vaultPresent: false });
    await expect(restored.invoke('imap_get_mailboxes', { accountId: account.id })).resolves.toMatchObject({ mailboxes: expect.arrayContaining([expect.objectContaining({ path: 'Kept after reload' })]) });
  });

  it('keeps custom folder create, rename and delete scoped to its account', async () => {
    const backend = createDemoBackend();
    const [first, second] = backend.snapshot().accounts;
    await backend.invoke('imap_create_mailbox', { accountId: first.id, path: 'Visitor/Projects' });
    await backend.invoke('imap_rename_mailbox', { accountId: first.id, from: 'Visitor/Projects', to: 'Visitor/Done' });
    const afterRename = await backend.invoke('imap_get_mailboxes', { accountId: first.id });
    const otherAccount = await backend.invoke('imap_get_mailboxes', { accountId: second.id });
    expect(afterRename.mailboxes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Visitor/Done' })]));
    expect(afterRename.mailboxes).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Visitor/Projects' })]));
    expect(otherAccount.mailboxes).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'Visitor/Done' })]));
    await backend.invoke('imap_delete_mailbox', { accountId: first.id, paths: ['Visitor/Done'] });
    await expect(backend.invoke('imap_get_mailboxes', { accountId: first.id })).resolves.toMatchObject({ mailboxes: expect.not.arrayContaining([expect.objectContaining({ path: 'Visitor/Done' })]) });
  });

  it('emits a silent durable event when a staged draft is discarded', async () => {
    const backend = createDemoBackend();
    const account = backend.snapshot().accounts[0];
    let event;
    backend.on('demo:state', ({ payload }) => { event = payload; });
    const raw = btoa('From: rowan@primecut.studio\nTo: demo@example.invalid\nSubject: Draft\n\nDraft body');
    await backend.invoke('maildir_store', { accountId: account.id, mailbox: 'Drafts', uid: 998001, rawSourceBase64: raw, flags: ['draft'] });
    await backend.invoke('maildir_delete', { accountId: account.id, mailbox: 'Drafts', uid: 998001 });
    expect(event).toMatchObject({ type: 'draft-deleted' });
    expect(backend.snapshot().messages.find(message => message.uid === 998001)).toMatchObject({ vaultPresent: false });
  });

  it('mirrors theme and palette changes alongside settings', async () => {
    let state = { theme: 'dark', palette: 'indigo' };
    let listener;
    const store = { getState: () => state, subscribe: callback => { listener = callback; return () => { listener = null; }; } };
    bindDemoThemeStore(store);
    state = { theme: 'light', palette: 'graphite' };
    listener(state);
    await new Promise(resolve => setTimeout(resolve, 0));
    const saved = JSON.parse(await demoBackend.invoke('read_settings_json'));
    expect(saved['mailvault-theme'].state).toMatchObject({ theme: 'light', palette: 'graphite' });
  });
});
