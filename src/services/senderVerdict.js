import { send } from './transport';

/**
 * The verdict on a message's sender, asked of the daemon
 * (`message.verify_sender`, src-core/src/sender_check.rs): the shield's
 * status, its tooltip lines, the issues the details popover lists, the
 * SPF/DKIM/DMARC results and what the message says about its DKIM signature.
 * Text comes back as catalog keys and values; `verdictLines` words them.
 *
 * One answer per distinct set of header fields, kept for the session, so the
 * badge, the popover and a reopened message share one call. A failed call is
 * not kept: the next look asks again.
 */

export const NO_VERDICT = Object.freeze({
  status: 'none',
  tooltip: [],
  issues: [],
  auth: { spf: null, dkim: null, dmarc: null },
  dkim: null,
});

const KEPT = 1000;
const answers = new Map();

export function _resetSenderVerdicts() { answers.clear(); }

const addressOf = (a) => (a && typeof a === 'object' ? { name: a.name ?? null, address: a.address ?? null } : a ?? null);

/** The header fields the verdict reads, as the daemon takes them. */
export function senderFields(email) {
  return {
    from: addressOf(email?.from),
    replyTo: Array.isArray(email?.replyTo) ? email.replyTo.map(addressOf) : addressOf(email?.replyTo),
    returnPath: email?.returnPath ?? null,
    authenticationResults: email?.authenticationResults ?? null,
    dkimSignature: email?.dkimSignature ?? null,
  };
}

export const verdictKey = (email) => JSON.stringify(senderFields(email));

/** The answer already in hand for these fields, or undefined. */
export function cachedVerdict(key) {
  return answers.get(key)?.value;
}

/** The verdict for a message; `NO_VERDICT` when the daemon could not be asked. */
export function verifySender(email) {
  const key = verdictKey(email);
  let entry = answers.get(key);
  if (!entry) {
    entry = {};
    entry.promise = send('message.verify_sender', senderFields(email)).then(
      (verdict) => { entry.value = verdict || NO_VERDICT; return entry.value; },
      (e) => {
        console.warn('[senderVerdict] message.verify_sender failed:', e);
        answers.delete(key);
        return NO_VERDICT;
      },
    );
    answers.set(key, entry);
    if (answers.size > KEPT) answers.delete(answers.keys().next().value);
  }
  return entry.promise;
}

/** One catalog line (`{key, params}`) in the user's language. */
export const lineText = (line, t) => t(line.key, line.params || {});

/** The shield's tooltip: its lines, one per row. */
export const verdictTooltip = (verdict, t) => (verdict?.tooltip || []).map((l) => lineText(l, t)).join('\n');

/** The issues a popover or a card lists: danger and warning, worded. */
export function shownIssues(verdict, t) {
  return (verdict?.issues || [])
    .filter((i) => i.level === 'danger' || i.level === 'warning')
    .map((i) => ({ level: i.level, text: lineText(i, t) }));
}
