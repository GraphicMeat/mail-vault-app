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
 * Move a Graph account's folders written under a localized name (the app's
 * key from v2.11.0 to v2.13.1) under the storage key Rust and the app now
 * share. Once per account: the flag is set only after the command succeeded,
 * so a failed launch retries next time. Never deletes: a folder that already
 * exists under the English key is left where it is on both sides (Rust
 * reports it as skipped). Needs no token — id, email and transport are in
 * accounts.json — so it can run before the keychain is read.
 */
export async function adoptGraphFolderKeys(accounts) {
  for (const account of accounts || []) {
    const settings = useSettingsStore.getState();
    if (!isGraphAccount(account) || settings.graphFolderKeysAdopted?.[account.id]) continue;
    const pairs = LEGACY_LOCALIZED_KEYS.map(([from, to]) => ({ from, to }));
    try {
      const report = await api.vaultAdoptMailboxDirs(account.id, account.email || null, pairs);
      const last = settings.getLastMailbox(account.id);
      const moved = LEGACY_LOCALIZED_KEYS.find(([from]) => from === last);
      if (moved) settings.setLastMailbox(account.id, moved[1]);
      settings.markGraphFolderKeysAdopted(account.id);
      if (report?.adopted?.length || report?.skipped_both_exist?.length) {
        console.log('[adoptGraphFolderKeys]', account.email, JSON.stringify(report));
      }
    } catch (e) {
      console.warn('[adoptGraphFolderKeys] failed for', account.email, e);
    }
  }
}
