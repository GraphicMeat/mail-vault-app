/**
 * Share-to-unlock reward configuration.
 *
 * Non-MAS only. After a successful backup, non-premium users are offered free
 * premium (same length as the free trial) for starring the repo and sharing
 * MailVault on social. The GitHub star is verified server-side; social shares
 * are honor-system (the reward is cheap, and friction kills conversion more
 * than abuse costs us). Each completed action stacks more premium time.
 *
 * Keep GITHUB_OWNER/GITHUB_NAME in sync with `src-tauri/src/github.rs`.
 */

export const GITHUB_OWNER = 'GraphicMeat';
export const GITHUB_NAME = 'mail-vault-app';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_NAME}`;

/** Premium days each completed action grants. */
export const REWARD_DAYS = {
  github: 5,
  x: 5,
  linkedin: 5,
};

/** Ordered for display. */
export const SHARE_ACTIONS = ['github', 'x', 'linkedin'];

/** Build social post copy that brags the actual milestone (proof-of-value). */
export function buildShareText(emailsBackedUp = 0) {
  const count = emailsBackedUp > 0 ? `${emailsBackedUp.toLocaleString()} ` : '';
  return `Just backed up ${count}emails locally with MailVault — open-source email backup where my mail never touches anyone else's servers. ⭐ ${GITHUB_REPO_URL}`;
}

export function xIntentUrl(text) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

export function linkedinShareUrl() {
  // LinkedIn scrapes OpenGraph tags from the shared URL.
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(GITHUB_REPO_URL)}`;
}
