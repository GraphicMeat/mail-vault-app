import * as api from '../api';
import { isGraphAccount } from '../graphConfig';
import { useSettingsStore } from '../../stores/settingsStore';

// FROZEN on purpose: the words v2.11.0 through v2.13.1 keyed Graph folders by,
// one per UI language (`list.sent`, `sidebar.drafts`, `settings.storage.trash`,
// `svc.graphConfig.junk`, `common.archive`). Directories on disk carry these
// names whatever the catalogs say later, so this table must not read them.
// German "Junk" equals its key and needs no entry; "Enviados" (es, pt-BR) is
// listed once.
export const LEGACY_LOCALIZED_KEYS = [
  ['Gesendet', 'Sent'], ['Enviados', 'Sent'], ['Envoyés', 'Sent'], ['Inviate', 'Sent'],
  ['送信済み', 'Sent'], ['보낸편지함', 'Sent'], ['已发送', 'Sent'],
  ['Entwürfe', 'Drafts'], ['Borradores', 'Drafts'], ['Brouillons', 'Drafts'], ['Bozze', 'Drafts'],
  ['下書き', 'Drafts'], ['임시보관함', 'Drafts'], ['Rascunhos', 'Drafts'], ['草稿', 'Drafts'],
  ['Papierkorb', 'Trash'], ['Papelera', 'Trash'], ['Corbeille', 'Trash'], ['Cestino', 'Trash'],
  ['ゴミ箱', 'Trash'], ['휴지통', 'Trash'], ['Lixeira', 'Trash'], ['废纸篓', 'Trash'],
  ['Correo no deseado', 'Junk'], ['Indésirables', 'Junk'], ['Posta indesiderata', 'Junk'],
  ['迷惑メール', 'Junk'], ['정크 메일', 'Junk'], ['Lixo eletrônico', 'Junk'], ['垃圾邮件', 'Junk'],
  ['Archivieren', 'Archive'], ['Archivar', 'Archive'], ['Archiver', 'Archive'], ['Archivia', 'Archive'],
  ['アーカイブ', 'Archive'], ['보관', 'Archive'], ['Arquivar', 'Archive'], ['归档', 'Archive'],
];

/**
 * The settings store persists through an async `getItem` (`read_settings_json`
 * over IPC) and its merge lets the persisted value overwrite what is in memory,
 * so a flag — or a rewritten last mailbox — written before hydration is thrown
 * away, and the account is adopted again on the next launch after the app has
 * already opened its folders under the new key. Wait for hydration first.
 */
export const HYDRATION_WAIT_MS = 5000;

async function hydrated() {
  const persist = useSettingsStore.persist;
  if (!persist?.hasHydrated || persist.hasHydrated()) return;
  // Bounded, because zustand's `hydrate()` sets `hasHydrated` and fires the
  // finish listeners inside a `.then()`: a rejection anywhere in that chain (a
  // throwing migration, a bad `JSON.parse` in the storage adapter) lands in its
  // `.catch` instead, leaving the flag false and every listener unfired
  // forever. Both passes are awaited on every boot path and at every Graph
  // listing, so an unbounded wait would hang activation, listing and refresh
  // with nothing on screen to explain it. Going ahead is safe: if the persisted
  // state is genuinely unavailable the flag is absent anyway, and the command
  // is a no-op when there is nothing to adopt.
  await new Promise((resolve) => {
    let unsub = () => {};
    const timer = setTimeout(() => {
      unsub();
      console.warn('[adoptGraphFolderKeys] settings did not hydrate in time; proceeding with in-memory state');
      resolve();
    }, HYDRATION_WAIT_MS);
    unsub = persist.onFinishHydration(() => {
      clearTimeout(timer);
      unsub();
      resolve();
    });
  });
}

/**
 * Move a Graph account's folders written under a localized name (the app's
 * key from v2.11.0 to v2.13.1) under the storage key Rust and the app now
 * share. Once per account: the flag is set only after the command succeeded
 * with nothing in `failed`, so a partial or failed launch retries next time.
 * Never deletes: a folder that already exists under the English key is left
 * where it is on both sides (Rust reports it as skipped). Needs no token — id,
 * email and transport are in accounts.json — so it can run before the keychain
 * is read.
 */
export async function adoptGraphFolderKeys(accounts) {
  // Ahead of the hydration wait: every install awaits this at first paint (the
  // quick load in App.jsx awaits it right above the setState that renders the
  // account list), and an IMAP-only one has nothing to adopt, so it must not
  // wait on the settings IPC.
  if (!(accounts || []).some(isGraphAccount)) return;
  await hydrated();
  for (const account of accounts || []) {
    const settings = useSettingsStore.getState();
    if (!isGraphAccount(account) || settings.graphFolderKeysAdopted?.[account.id]) continue;
    const pairs = LEGACY_LOCALIZED_KEYS.map(([from, to]) => ({ from, to }));
    try {
      const report = await api.vaultAdoptMailboxDirs(account.id, account.email || null, pairs);
      // Rust already rejects a report with anything in `failed`; belt and
      // braces, because a half-moved account must not be marked done.
      if (report?.failed?.length) {
        console.warn('[adoptGraphFolderKeys] failed for', account.email, JSON.stringify(report));
        continue;
      }
      const last = settings.getLastMailbox(account.id);
      const moved = LEGACY_LOCALIZED_KEYS.find(([from]) => from === last);
      if (moved) settings.setLastMailbox(account.id, moved[1]);
      settings.markGraphFolderKeysAdopted(account.id);
      if (report?.adopted?.length || report?.skipped_both_exist?.length) {
        // A blocked pair means a legacy directory is still on disk holding mail
        // the new key will not show: warn, so a support log carries it.
        const log = report.skipped_both_exist?.length ? console.warn : console.log;
        log('[adoptGraphFolderKeys]', account.email, JSON.stringify(report));
      }
    } catch (e) {
      console.warn('[adoptGraphFolderKeys] failed for', account.email, e);
    }
  }
}

/**
 * The second population: a folder stored under the SERVER's word for it.
 * Before this release a Graph folder whose display name was not one of
 * Outlook's English defaults was keyed by that display name, so a German
 * mailbox's Sent lived under "Gesendete Elemente". The listing now says what
 * each well-known folder is called and what its key is, and that pair is the
 * adoption. Once per account, at the first listing after upgrade, awaited
 * before the listing is used, so nothing writes under the new key first.
 */
export async function adoptGraphFolderKeysFromListing(account, graphFolders) {
  if (!isGraphAccount(account)) return;
  await hydrated();
  const settings = useSettingsStore.getState();
  if (settings.graphFolderKeysAdoptedFromListing?.[account.id]) return;
  // Case-insensitively: an English mailbox lists "Inbox" against the key
  // "INBOX", and on a case-insensitive volume (every default macOS one) that
  // pair is one directory, so it can only block itself and log a skip that
  // means nothing.
  const pairs = (graphFolders || [])
    .filter((f) => f.wellKnownName && f.storageKey && f.displayName.toLowerCase() !== f.storageKey.toLowerCase())
    .map((f) => ({ from: f.displayName, to: f.storageKey }));
  try {
    if (pairs.length) {
      const report = await api.vaultAdoptMailboxDirs(account.id, account.email || null, pairs);
      if (report?.failed?.length) {
        console.warn('[adoptGraphFolderKeys] listing pass failed for', account.email, JSON.stringify(report));
        return;
      }
      const last = settings.getLastMailbox(account.id);
      const moved = pairs.find((p) => p.from === last);
      if (moved) settings.setLastMailbox(account.id, moved.to);
      if (report?.adopted?.length || report?.skipped_both_exist?.length) {
        const log = report.skipped_both_exist?.length ? console.warn : console.log;
        log('[adoptGraphFolderKeys] listing pass', account.email, JSON.stringify(report));
      }
    }
    settings.markGraphFolderKeysAdoptedFromListing(account.id);
  } catch (e) {
    console.warn('[adoptGraphFolderKeys] listing pass failed for', account.email, e);
  }
}
