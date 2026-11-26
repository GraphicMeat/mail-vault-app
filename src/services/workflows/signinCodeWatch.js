import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getAccountCacheMailboxes } from '../cacheManager';
import { isGraphAccount, graphMessageToEmail } from '../graphConfig';
import { flattenMailboxes } from '../../stores/slices/unifiedHelpers';
import { ownAddresses } from '../../utils/ownAddresses';
import { htmlToPlainText } from '../../utils/emailParser';

/**
 * Billing's code sign-in: find the code MailVault just mailed and hand it over, so nobody has
 * to type it. The mail is looked for on the server, in Inbox and in Spam (a first mail from a
 * new sender often lands there, and Spam is not synced live), and only MailVault's own sign-in
 * mail sent after the code was asked for is read. The code itself is read by the daemon's
 * detector (`message.code`).
 */

// The subject of the sign-in mail in each language it is sent in
// (website/api/signin-code-email.js; website/__tests__/signin-code-fixture.test.js keeps the
// two in step).
export const SIGNIN_SUBJECTS = [
  "Your MailVault sign-in code",
  "Dein MailVault-Anmeldecode",
  "Votre code de connexion MailVault",
  "Tu código de acceso de MailVault",
  "Il tuo codice di accesso MailVault",
  "MailVaultのログインコード",
  "MailVault 로그인 코드",
  "你的 MailVault 登录验证码",
  "Seu código de acesso do MailVault",
];
const SUBJECTS = new Set(SIGNIN_SUBJECTS.map(s => s.normalize('NFC')));
const isSigninMail = (subject) => SUBJECTS.has(String(subject || '').trim().normalize('NFC'));

// Servers name Spam anything; only the last path segment counts.
const SPAM_NAME = /^(spam|junk|junk ?e-?mail|bulk ?mail)$/i;
// A mail clock a little behind ours still counts.
const CLOCK_SLACK_MS = 2 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;

/** The accounts here that receive mail for `email` (its login, its aliases, its send-as). */
function accountsFor(email) {
  const wanted = String(email || '').trim().toLowerCase();
  const settings = useSettingsStore.getState();
  return (useMailStore.getState().accounts || []).filter(account => ownAddresses({
    account, sendAsAddress: settings.sendAsAddresses?.[account.id], aliases: settings.aliases?.[account.id],
  }).some(a => a.toLowerCase() === wanted));
}

/** Inbox, then the account's Spam folder: the one marked \Junk, else one named like it. */
function foldersOf(account) {
  const mail = useMailStore.getState();
  const tree = (account.id === mail.activeAccountId ? mail.mailboxes : getAccountCacheMailboxes(account.id)) || [];
  const boxes = flattenMailboxes(tree);
  const junk = boxes.find(b => String(b.specialUse || b.special_use || '').toLowerCase() === '\\junk')
    || boxes.find(b => SPAM_NAME.test(String(b.path).split(/[/.]/).pop().trim()));
  return junk && junk.path !== 'INBOX' ? ['INBOX', junk.path] : ['INBOX'];
}

const sentAt = (header) => Date.parse(header?.date || header?.receivedAt || header?.internalDate || '') || 0;

async function codeIn(api, subject, text) {
  return (await api.messageCode(subject, text))?.code || null;
}

// Sent after the request (a little clock skew allowed) and not dated ahead of now.
const inWindow = (header, since, now) => {
  const at = sentAt(header);
  return at >= since - CLOCK_SLACK_MS && at <= now + CLOCK_SLACK_MS;
};

async function imapCode(api, account, since, now) {
  // IMAP SINCE is a whole day: ask from the day before, then compare times here.
  const day = new Date(since - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const found = [];
  for (const mailbox of foldersOf(account)) {
    const res = await api.searchEmails(account, mailbox, '', { subject: 'MailVault', since: day });
    for (const h of res?.emails || []) {
      if (isSigninMail(h.subject) && inWindow(h, since, now)) found.push({ h, mailbox });
    }
  }
  found.sort((a, b) => sentAt(b.h) - sentAt(a.h));
  const newest = found[0];
  if (!newest) return null;
  const body = await api.fetchEmailLight(account, newest.h.uid, newest.mailbox, account.id, { background: true });
  return codeIn(api, newest.h.subject, body?.text || htmlToPlainText(body?.html || ''));
}

async function graphCode(api, account, since, now) {
  const found = [];
  for (const folder of ['inbox', 'junkemail']) {
    const res = await api.graphListMessages(account, folder, 10, 0);
    (res?.headers || []).forEach((h, i) => {
      const id = res.graphMessageIds?.[i];
      if (id && isSigninMail(h.subject) && inWindow(h, since, now)) found.push({ h, id });
    });
  }
  found.sort((a, b) => sentAt(b.h) - sentAt(a.h));
  const newest = found[0];
  if (!newest) return null;
  const email = graphMessageToEmail(await api.graphGetMessage(account, newest.id), 0);
  return codeIn(api, newest.h.subject, email?.text || htmlToPlainText(email?.html || ''));
}

/**
 * The code in the newest MailVault sign-in mail to `email` sent since `since` (ms), from any
 * account here that receives that address, or null. Never throws.
 */
export async function findSigninCode({ email, since, now = Date.now }) {
  const api = await import('../api');
  for (const account of accountsFor(email)) {
    try {
      // A JMAP account (isJmapAccount) takes the IMAP path: the daemon answers its search and
      // body reads through the JMAP bridge. Only a Microsoft account on Graph lists by folder.
      const code = isGraphAccount(account) ? await graphCode(api, account, since, now()) : await imapCode(api, account, since, now());
      if (code) return code;
    } catch (e) {
      console.warn('[signinCodeWatch] Could not look for the sign-in code:', e?.message || e);
    }
  }
  return null;
}

/**
 * Look for the code every few seconds until it is found (handed to `onCode` once, so a
 * look-alike mail costs at most one attempt), the latest code has expired, or the returned
 * stop function is called. `since` is the first live request (after a resend its mail may be
 * the only one that arrives), `startedAt` the latest.
 */
export function watchSigninCode({ email, since, startedAt = since, onCode, now = Date.now }) {
  let stopped = false;
  let timer = null;
  const delay = () => (now() - startedAt < 60_000 ? 4_000 : 8_000);
  const tick = async () => {
    if (stopped) return;
    if (now() - startedAt > CODE_TTL_MS) { stopped = true; return; }
    const code = await findSigninCode({ email, since, now });
    if (stopped) return;
    if (code) { stopped = true; onCode(code); return; }
    timer = setTimeout(tick, delay());
  };
  timer = setTimeout(tick, delay());
  return () => { stopped = true; clearTimeout(timer); };
}
