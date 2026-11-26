// Which accounts have a problem only the user can fix, and how the one issue row names them.
// Pure: the row, the sheet and the avatars' warning dot all read this list.
//
// Three kinds, one per account at most:
//   signIn        the provider no longer honours the sign-in (`needsAuth`, OAuth): sign in again
//   passwordLost  a password account whose saved password is gone (`needsAuth`, `oauth: false`):
//                 entered again on the account's Mail Server page
//   refused       the server refused the password and the engine stopped dialling (`authRefused`):
//                 one Try again, or a new password

/** `[{ accountId, email, kind }]` for the accounts of `accounts` that need the user, in order. */
export function accountIssues(accounts) {
  const out = [];
  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (!a) continue;
    if (a.needsAuth) out.push({ accountId: a.id, email: a.email, kind: a.oauth === false ? 'passwordLost' : 'signIn' });
    else if (a.authRefused) out.push({ accountId: a.id, email: a.email, kind: 'refused' });
  }
  return out;
}

/** A name for the set of issues: the same accounts with the same problems give the same key. */
export function issueKey(issues) {
  return issues.map((i) => `${i.accountId}:${i.kind}`).sort().join('|');
}

/** Whether a dismissal (`dismissedKey`) still covers exactly this set of issues. */
export function dismissedFor(issues, dismissedKey) {
  return issues.length > 0 && typeof dismissedKey === 'string' && dismissedKey === issueKey(issues);
}

const ONE = {
  signIn: 'mobile.issues.signInOne',
  refused: 'mobile.issues.refusedOne',
  passwordLost: 'mobile.issues.passwordLostOne',
};

/** The catalog key and params of the row's and the sheet's title: one account by name, else a count. */
export function issueTitle(issues) {
  if (issues.length === 1) return { key: ONE[issues[0].kind], params: { email: issues[0].email } };
  return { key: 'mobile.issues.many', params: { accounts: issues.length } };
}
