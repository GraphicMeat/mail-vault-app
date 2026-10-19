// Daemon-shaped answers to `message.verify_sender` for component and export
// tests. The rules that produce them are the daemon's (src-core/src/sender_check.rs,
// checked against the JS it replaced); these tests check what the UI does
// with an answer: wording, masking, which surfaces show it.

const KEY = 'util.senderCheck.';

export const issue = (level, key, params = {}) => ({ level, key: KEY + key, params });

export function verdict({ status = 'none', issues = [], auth = {}, dkim = null } = {}) {
  const tooltip = status === 'verified'
    ? [{ key: `${KEY}senderVerifiedSpfDkimPass`, params: {} }]
    : status === 'none' ? [] : issues.map(({ key, params }) => ({ key, params }));
  return { status, tooltip, issues, auth: { spf: null, dkim: null, dmarc: null, ...auth }, dkim };
}

/**
 * A `vi.mock` factory for services/senderVerdict that answers from `answer`
 * (called with the header fields the daemon would get) at once, so the badge
 * and popover paint on the first render:
 *   vi.mock('.../services/senderVerdict', (orig) => stubSenderVerdicts(orig, fields => verdict(...)))
 */
export async function stubSenderVerdicts(importOriginal, answer) {
  const real = await importOriginal();
  return {
    ...real,
    cachedVerdict: (key) => answer(JSON.parse(key)),
    verifySender: async (email) => answer(real.senderFields(email)),
  };
}
