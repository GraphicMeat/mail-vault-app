// The JMAP failure codes the daemon sends, and the words the app shows for
// them: in the account form (describeConnectionError), in toasts, the outbox
// bubble and the pending-actions list (tErr).
import { describe, it, expect, afterEach } from 'vitest';
import { jmapErrorKey } from '../jmapErrors';
import { tErr, setLocale } from '../../i18n/index.js';
import en from '../../i18n/locales/en.json';

afterEach(async () => { await setLocale('en'); });

describe('jmapErrorKey', () => {
  it('maps every code the carries name, by code or by message', () => {
    const cases = {
      E_JMAP_AUTH: 'errors.jmapAuthFailed',
      'E_JMAP_AUTH: authentication failed': 'errors.jmapAuthFailed',
      'E_JMAP_TRANSPORT: connection refused': 'errors.jmapConnect',
      'E_JMAP_FOREIGN_HOST: evil.example': 'errors.jmapForeignHost',
      'E_JMAP_NO_TRASH: the account has no Trash mailbox to move UID 4 from INBOX into': 'errors.jmapNoTrash',
      'E_JMAP_NO_IDENTITY: the server lists no identity for b@x.test, so it will not send as that address': 'errors.jmapNoIdentity',
      'E_JMAP_NO_SUBMISSION: the server does not let a@x.test send with these credentials': 'errors.jmapNoSubmission',
      'E_JMAP_TOO_LARGE: this message is 9 bytes and the server takes at most 1 bytes': 'errors.jmapTooLarge',
      'E_JMAP_SUBMIT:forbiddenFrom: may not send as x': 'errors.jmapNoIdentity',
      'E_JMAP_SUBMIT:tooLarge: too big': 'errors.jmapTooLarge',
      'E_JMAP_SUBMIT:forbiddenToSend: quota': 'errors.jmapSendRefused',
      'E_JMAP_SUBMIT:serverFail: the server refused the message': 'errors.jmapSendRefused',
      'E_JMAP_UNSUPPORTED: imap_not_bridged': 'errors.jmapUnsupported',
      'E_JMAP_NOT_IMAP: a@x.test is a JMAP account; this path must branch on uses_jmap()': 'errors.jmapUnsupported',
      'E_JMAP_METHOD: mailboxHasEmail: Trash/Old: 3 emails': 'errors.jmapFolderNotEmpty',
      // A throttled server is the provider limiting this account.
      'E_JMAP_RATE: rate limited': 'errors.conn.problem.providerThrottling',
      // Everything else the server or the exchange got wrong is one fault, in words.
      'E_JMAP_PROTOCOL: no apiUrl': 'errors.jmapServerFault',
      'E_JMAP_CHANGES: cannotCalculateChanges': 'errors.jmapServerFault',
      'E_JMAP_METHOD: invalidArguments: x': 'errors.jmapServerFault',
      'E_JMAP_METHOD: serverFail': 'errors.jmapServerFault',
    };
    for (const [input, key] of Object.entries(cases)) {
      expect(jmapErrorKey(input), input).toBe(key);
      expect(key in en, key).toBe(true);
    }
  });

  it('reads an Error by its errorCode first, then its message', () => {
    expect(jmapErrorKey(Object.assign(new Error('whatever'), { errorCode: 'E_JMAP_AUTH' }))).toBe('errors.jmapAuthFailed');
    expect(jmapErrorKey(new Error('E_JMAP_NO_TRASH: none'))).toBe('errors.jmapNoTrash');
  });

  it('is null for what it does not word: other codes, other errors, nothing', () => {
    for (const input of ['E_JMAP_SOMETHING_NEW: x',
      'E_UID_GONE: Message UID 4 is no longer in INBOX', 'auth', 'socket closed', '', null, undefined]) {
      expect(jmapErrorKey(input), String(input)).toBeNull();
    }
  });
});

describe('tErr on a JMAP failure', () => {
  it('shows the catalog words in English, not the Rust tail', () => {
    expect(tErr('E_JMAP_METHOD: mailboxHasEmail: Trash/Old: 3 emails')).toBe(en['errors.jmapFolderNotEmpty']);
    expect(tErr(new Error('E_JMAP_NO_TRASH: the account has no Trash mailbox'))).toBe(en['errors.jmapNoTrash']);
  });

  it('shows the translation with the English in brackets elsewhere', async () => {
    await setLocale('de');
    expect(tErr('E_JMAP_NO_TRASH: the account has no Trash mailbox'))
      .toBe('Dieses Konto hat keinen Papierkorb, daher wurde nichts gelöscht. (This account has no Trash folder, so nothing was deleted.)');
  });

  it('leaves every other E_ code to the existing rule', () => {
    expect(tErr('E_UID_GONE: Message UID 42 is no longer in INBOX')).toBe('Message UID 42 is no longer in INBOX');
  });
});
