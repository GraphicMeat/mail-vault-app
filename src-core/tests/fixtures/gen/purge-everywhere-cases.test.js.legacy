// Captures the actual exported JS workflow. Replies below are dependency inputs,
// never a replacement purge model. Generate remotely; transfer marked bytes.
import { it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as h from '../../../../src/services/workflows/__tests__/purgeEverywhereHarness.js';

const copy = value => JSON.parse(JSON.stringify(value, (_key, v) =>
  v instanceof Set ? [...v] : v instanceof Map ? [...v] : v));
const account2 = { id: '22222222-2222-4222-8222-222222222222', email: 'two@example.test' };
const mb = 'INBOX.Spam';
const key = (uid, mailbox = mb, accountId = h.ACCOUNT.id) => `${accountId}:${mailbox}:${uid}`;
const row = (uid, extra = {}) => ({ ...h.serverMsg(uid), ...extra });
const located = (uid, mailbox, accountId = h.ACCOUNT.id, extra = {}) =>
  row(uid, { _accountId: accountId, _mailbox: mailbox, ...extra });

// Every exception names the observable boundary and the later acceptance owner.
// A successful legacy result is not authorization for a native implementation.
const exceptions = [
  { id: 'ui-local-trust', kind: 'safety-correction', owner: 'D/E', cases: ['staged-without-custody', 'stale-winning-staged-row', 'local-sent', 'local-draft', 'missing-account-local'], reason: 'JS accepts UI _localStaged or provenance alone; native custody/receipt and exact selected byte identity must prove ownership.' },
  { id: 'loose-identity', kind: 'safety-correction', owner: 'B/C/E', cases: ['offscreen-key', 'no-message-id', 'graph-ledger', 'graph-row-over-ledger'], reason: 'JS checks current generation or a row/ledger Graph ID, not original selected generation/origin/provider/byte proof. Missing Message-ID itself must remain supported with native proof.' },
  { id: 'non-uidplus', kind: 'safety-correction', owner: 'E', cases: ['imap-equal'], reason: 'deleteEmail is mocked here. Legacy adapter may broad EXPUNGE without UIDPLUS; bound native purge must refuse before STORE and preserve unrelated Deleted messages.' },
  { id: 'jmap-label-last-gone', kind: 'native-acceptance', owner: 'E', cases: ['jmap-transport'], reason: 'JS sees checkMailboxStatus/deleteEmail only. Actual JMAP remove-label, destroy-last, Gone handling and ledger retention are behind the API and must be tested natively; no invented JMAP trace.' },
  { id: 'backup-configuration', kind: 'native-acceptance', owner: 'E', cases: ['backup-configured-offline', 'backup-unconfigured'], reason: 'These are scripted backupPurgeUids replies. Actual native configured/unavailable queue insertion versus unconfigured no-op and native bookmark/root ownership require native tests.' },
  { id: 'local-partial-io', kind: 'native-acceptance', owner: 'E', cases: ['vault-partial-failure'], reason: 'The thrown vault reply characterizes counters and the following mirror attempt. Actual partial file removal, byte safety, registry/custody state and storage-format support need native IO tests.' },
  { id: 'graph-resolver', kind: 'native-acceptance', owner: 'B/E', cases: ['graph-row-over-ledger', 'graph-ledger', 'graph-miss'], reason: 'The existing test resolver chooses row _graphId then mocked ledger. Native original ID validation, collisions, relist and actual DELETE-to-Deleted-Items semantics are separate acceptance.' },
];

function presentationState() {
  const s = h.useMailStore.getState();
  return copy({ activeAccountId: s.activeAccountId, activeMailbox: s.activeMailbox,
    emails: s.emails, sentEmails: s.sentEmails, localEmails: s.localEmails,
    selectedEmailIds: s.selectedEmailIds, selectedEmailId: s.selectedEmailId,
    selectedEmail: s.selectedEmail, selectedThread: s.selectedThread,
    totalEmails: s.totalEmails, tombstones: s.deleteTombstones,
    saved: s.savedEmailIds, archived: s.archivedEmailIds,
    undo: s.undo ? { labelKey: s.undo.labelKey, canUndo: s.undo.canUndo } : null,
    error: s.error, errorType: s.errorType, errorTypeFor: s.errorTypeFor });
}

async function runCase(c) {
  h.resetPurgeMocks();
  h.useMailStore.setState({ mailboxScope: null, localFolders: {}, mailboxes: [],
    selectedThread: null, selectedEmailSource: null, error: null,
    errorType: null, errorTypeFor: null, undo: null,
    unifiedFolder: 'INBOX', unifiedEmails: [] });
  h.prime({ emails: c.emails ?? [row(1)], localOnly: c.localOnly ?? [],
    archived: c.archived ?? [], sent: c.sent ?? [], provenance: new Map(c.provenance ?? []) });
  const account = { ...h.ACCOUNT, ...(c.account ?? {}) };
  h.useMailStore.setState({ accounts: c.accounts ?? [account, account2],
    selectedEmailIds: new Set(c.keys ?? [1]), ...c.state });
  h.mockSearch.searchResults = c.search ?? [];
  h.mockIsGraphAccount.mockImplementation(a => c.graph === true && a?.id === account.id);
  h.useMailStore.getState().updateSortedEmails();

  let order = 0;
  const effects = [], progress = [], presentation = [], preparation = [];
  const add = (list, entry) => list.push({ order: ++order, ...copy(entry) });
  const effect = async (name, args, reply) => {
    const event = { order: ++order, effect: name, ...copy(args) };
    effects.push(event);
    try { const result = await reply(); event.reply = copy(result ?? null); return result; }
    catch (e) { event.error = e.message; throw e; }
  };
  const paint = (effect, args) => add(presentation, { effect, ...args });
  let previous = presentationState();
  const unsubscribe = h.useMailStore.subscribe(() => {
    const next = presentationState();
    const changed = Object.fromEntries(Object.keys(next).filter(k => JSON.stringify(next[k]) !== JSON.stringify(previous[k])).map(k => [k, next[k]]));
    if (Object.keys(changed).length) paint('store', { changed });
    previous = next;
  });
  const switchView = () => {
    paint('user-switch-view', {});
    h.useMailStore.setState({ activeAccountId: account2.id, activeMailbox: 'Other',
      emails: [located(1, 'Other', account2.id)], localEmails: [located(99, 'Other', account2.id)],
      selectedEmailIds: new Set([99]), totalEmails: 17 });
  };
  h.mockGetLocalIndexProvenance.mockImplementation((accountId, mailbox) => effect('provenance', { accountId, mailbox }, async () => {
    if (c.tickDuringProvenance) {
      paint('user-tick', { key: 2 });
      h.useMailStore.setState(s => ({ selectedEmailIds: new Set([...s.selectedEmailIds, 2]) }));
    }
    return new Map(c.provenance ?? []);
  }));
  h.mockGetEmailHeadersMeta.mockImplementation((accountId, mailbox) => effect('headers-meta', { accountId, mailbox }, async () => ({ uidValidity: (c.generations?.[mailbox] ?? c.generation ?? [1, 1])[0] })));
  h.mockCheckMailboxStatus.mockImplementation((a, mailbox) => effect('status', { accountId: a.id, mailbox }, async () => {
    if (c.statusError) throw new Error(c.statusError);
    return { uidValidity: (c.generations?.[mailbox] ?? c.generation ?? [1, 1])[1] };
  }));
  h.mockDeleteEmail.mockImplementation((a, uid, mailbox, permanent, options) => effect('server-delete', { accountId: a.id, uid, mailbox, permanent, options }, async () => {
    if (c.switchDuringServer) switchView();
    if (c.serverFailures?.includes(uid)) throw new Error('scripted server refusal');
  }));
  h.mockGetGraphMessageId.mockImplementation((accountId, mailbox, uid) => {
    const id = c.graphLedger ?? null;
    add(effects, { effect: 'graph-ledger', accountId, mailbox, uid, reply: id });
    return id;
  });
  h.mockGraphDeleteMessage.mockImplementation((a, graphId) => effect('graph-delete', { accountId: a.id, graphId }, async () => {
    if (c.graphError) throw new Error(c.graphError);
  }));
  h.mockMaildirDeleteMany.mockImplementation((accountId, mailbox, uids) => effect('vault-delete', { accountId, mailbox, uids }, async () => {
    if (c.vaultError) throw new Error(c.vaultError);
    return c.vaultReply ?? { removed: uids.length };
  }));
  h.mockBackupPurgeUids.mockImplementation((email, mailbox, uids) => effect('mirror-purge', { email, mailbox, uids }, async () => {
    if (c.backupError) throw new Error(c.backupError);
    return c.backupReply ?? { removed: uids.length, queued: 0 };
  }));
  h.mockGetVaultUidSets.mockImplementation((accountId, mailbox) => effect('vault-refresh', { accountId, mailbox }, async () => {
    if (c.switchDuringRefresh) switchView();
    return { saved: new Set(), archived: new Set() };
  }));
  h.mockGetLocalEmails.mockImplementation((accountId, mailbox) => effect('local-refresh', { accountId, mailbox }, async () => []));
  h.mockSaveEmailHeaders.mockImplementation(async (accountId, mailbox, rows, total, options) => paint('header-write', { accountId, mailbox, rows, total, options }));
  h.mockRemoveSearchResults.mockImplementation(keys => paint('search-remove', { keys }));
  h.useMailStore.setState({ loadEmails: () => paint('reload', {}) });

  const selected = { keys: c.keys ?? [1], scope: { accountId: h.useMailStore.getState().activeAccountId,
    mailbox: h.useMailStore.getState().activeMailbox, mailboxScope: h.useMailStore.getState().mailboxScope },
    rows: { emails: h.useMailStore.getState().emails, local: h.useMailStore.getState().localEmails,
      sent: h.useMailStore.getState().sentEmails, search: h.mockSearch.searchResults } };
  try {
    if (c.undo) {
      // Exercise the real Undo export and real rekey, not a private-state stub.
      const restored = row(71);
      let finishMove, enteredMove;
      const entered = new Promise(resolve => { enteredMove = resolve; });
      h.mockMoveEmails.mockImplementation((a, uids, from, to) => {
        add(preparation, { effect: 'undo-move', accountId: a.id, uids, from, to });
        enteredMove();
        return new Promise(resolve => { finishMove = resolve; });
      });
      add(preparation, { effect: 'undo-input', accountId: account.id, mailbox: mb, uid: 71, row: restored });
      await h.setDeleteUndo([{ account, accountId: account.id, mailbox: mb, uid: 71,
        trash: 'Trash', trashUid: 5, messageId: restored.messageId, row: restored,
        view: `${account.id}|${mb}||INBOX` }]);
      const undo = h.useMailStore.getState().runUndo();
      await entered;
      const pendingPurge = h.purgeEverywhere(c.keys, { onProgress: value => add(progress, value) });
      add(preparation, { effect: 'purge-waits-for-undo', providerCalls: effects.filter(e => e.effect === 'server-delete').length });
      finishMove({ newUids: [171] });
      expect(await undo).toBe(true);
      const result = await pendingPurge;
      return { name: c.name, input: copy(c), selected: copy(selected), result, effects, progress, presentation, preparation, final: presentationState() };
    }
    h.useMailStore.getState().setUndo({ labelKey: 'undo.deleted', run: async () => {} });
    let result = null, thrown = null;
    try {
      result = await (c.reporting ? h.purgeEverywhereReporting : h.purgeEverywhere)(selected.keys,
        { onProgress: value => add(progress, value) });
    } catch (e) { thrown = e.message; }
    return { name: c.name, input: copy(c), selected: copy(selected), result, thrown,
      effects, progress, presentation, preparation, final: presentationState() };
  } finally { unsubscribe(); }
}

const cases = [
  { name: 'imap-equal', emails: [row(1), row(2)], keys: [1], archived: [1] },
  { name: 'imap-missing-cached-generation', generation: [null, 1], reporting: true },
  { name: 'imap-missing-live-generation', generation: [1, null] },
  { name: 'imap-mismatched-generation', generation: [1, 2], reporting: true },
  { name: 'imap-status-offline', statusError: 'offline' },
  { name: 'mixed-local-server-groups', emails: [row(1), row(2), located(3, 'Work:Clients', account2.id)],
    localOnly: [row(9)], provenance: [[9, 'local_sent']], keys: [9, 1, 2, key(3, 'Work:Clients', account2.id)], serverFailures: [2] },
  { name: 'mixed-generation-groups', emails: [row(1), located(3, 'Work:Clients')], keys: [1, key(3, 'Work:Clients')], generations: { 'Work:Clients': [4, 5] } },
  { name: 'server-refusal', serverFailures: [1], archived: [1], backupReply: { removed: 0, queued: 1 }, reporting: true },
  { name: 'vault-partial-failure', emails: [row(1), row(2)], keys: [1, 2], vaultError: 'partial local IO after one removal', backupReply: { removed: 0, queued: 2 } },
  { name: 'vault-partial-reply', emails: [row(1), row(2)], keys: [1, 2], vaultReply: { removed: 1 } },
  { name: 'backup-configured-offline', backupReply: { removed: 0, queued: 1 }, reporting: true },
  { name: 'backup-unconfigured', backupReply: { removed: 0, queued: 0 }, reporting: true },
  { name: 'backup-error', backupError: 'mirror IO failure' },
  { name: 'graph-row-over-ledger', graph: true, emails: [row(1, { _graphId: 'original-row-id' })], graphLedger: 'different-ledger-id' },
  { name: 'graph-ledger', graph: true, graphLedger: 'ledger-id' },
  { name: 'graph-miss', graph: true },
  { name: 'graph-refusal', graph: true, graphLedger: 'ledger-id', graphError: 'provider refusal' },
  { name: 'jmap-transport', account: { jmapSessionUrl: 'https://jmap.example.test/session' } },
  { name: 'missing-account', accounts: [], emails: [], keys: [1] },
  { name: 'missing-account-local', accounts: [], emails: [], localOnly: [row(9)], keys: [9], provenance: [[9, 'local_sent']] },
  { name: 'missing-account-email', account: { email: null } },
  { name: 'unified-missing-account', emails: [], keys: [key(1, 'INBOX', 'missing')], state: { activeMailbox: 'UNIFIED' } },
  { name: 'custom-local-exclusion', keys: [1], state: { localFolders: { [h.ACCOUNT.id]: [{ name: 'Import', dir: mb }] } } },
  ...['local_sent', 'local_draft'].map(source => ({ name: source.replace('_', '-'), emails: [], localOnly: [row(9)], keys: [9], provenance: [[9, source]], generation: [1, 2] })),
  { name: 'unproven-local-display', emails: [], localOnly: [row(9, { source: 'local-only' })], keys: [9], provenance: [[9, 'local']] },
  { name: 'staged-without-custody', emails: [], sent: [row(9, { _localStaged: true })], keys: [9] },
  { name: 'stale-winning-staged-row', emails: [row(1, { _localStaged: true })] },
  { name: 'stale-local-duplicate', localOnly: [row(1, { _localStaged: true, source: 'local-only' })] },
  { name: 'merged-sent', emails: [row(1)], sent: [located(1, 'Sent', h.ACCOUNT.id, { _fromSentFolder: true })], keys: [key(1, 'Sent')] },
  { name: 'mailbox-colons', emails: [located(1, 'Work:Clients')], keys: [key(1, 'Work:Clients')] },
  { name: 'offscreen-key', emails: [], keys: [key(77, 'Work:Clients')] },
  { name: 'offscreen-search-graph', graph: true, emails: [], search: [located(77, 'Work:Clients', h.ACCOUNT.id, { _graphId: 'search-row-id' })], keys: [key(77, 'Work:Clients')] },
  { name: 'no-message-id', emails: [row(1, { messageId: null })] },
  { name: 'unified-colliding-uids', emails: [located(1, 'INBOX'), located(1, 'INBOX', account2.id)], keys: [key(1, 'INBOX'), key(1, 'INBOX', account2.id)], state: { activeMailbox: 'UNIFIED' } },
  { name: 'tick-during-provenance', emails: [row(1), row(2)], tickDuringProvenance: true },
  { name: 'view-switch-during-server', switchDuringServer: true },
  { name: 'view-switch-during-refresh', switchDuringRefresh: true },
  { name: 'reader-thread-clear', emails: [row(1), row(2)], keys: [1, 99], state: { selectedEmailId: 1, selectedEmail: row(1), selectedEmailSource: 'server', selectedThread: { threadId: 'm1@mock', emails: [row(1)], lastEmail: row(1), messageCount: 1 } } },
  { name: 'clean-reporting-silence', reporting: true },
  { name: 'empty', keys: [] },
  { name: 'undo-rekey-in-flight', emails: [], keys: [71], undo: true },
];

it('captures real purge decisions and compares the remote corpus', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T00:00:00.000Z'));
  try {
    const runs = [];
    for (const c of cases) runs.push(await runCase(c));
    const sourcePaths = ['src/services/workflows/messageMutations.js', 'src/services/workflows/__tests__/purgeEverywhereHarness.js'];
    const fixture = { schemaVersion: 1, boundary: 'actual JS purgeEverywhere export with scripted dependency replies',
      source: { inputRevision: execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim(),
        snapshotCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        generatorSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
        files: Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) },
      exceptions, runs };
    const path = new URL('../purge-everywhere-cases.json', import.meta.url);
    if (process.env.MAILVAULT_GENERATE_PURGE_FIXTURE === '1') {
      writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
      console.log('PURGE_FIXTURE_BASE64_BEGIN');
      console.log(Buffer.from(readFileSync(path)).toString('base64'));
      console.log('PURGE_FIXTURE_BASE64_END');
    } else {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(fixture.exceptions).toEqual(saved.exceptions);
      expect(fixture.runs).toEqual(saved.runs);
      // Source hashes are historical provenance. Later unrelated edits in the
      // workflow file must not rewrite this oracle; compare live traces instead.
      expect(fixture.source.generatorSha256).toBe(saved.source.generatorSha256);
    }
    const byName = name => runs.find(r => r.name === name);
    expect(byName('server-refusal').effects.some(e => ['vault-delete', 'mirror-purge'].includes(e.effect))).toBe(false);
    expect(byName('vault-partial-failure').result).toEqual({ deleted: 2, failed: 0, queuedBackup: 2, needsResync: 0 });
    expect(byName('stale-local-duplicate').effects.some(e => e.effect === 'server-delete')).toBe(true);
    expect(byName('stale-winning-staged-row').effects.some(e => e.effect === 'server-delete')).toBe(false);
    expect(byName('undo-rekey-in-flight').effects.find(e => e.effect === 'server-delete')?.uid).toBe(171);
    expect(byName('tick-during-provenance').final.selectedEmailIds).toEqual([2]);
    expect(byName('view-switch-during-server').presentation.find(e => e.effect === 'header-write')?.total).toBeNull();
    expect(byName('clean-reporting-silence').final.error).toBeNull();
  } finally { vi.useRealTimers(); }
});
