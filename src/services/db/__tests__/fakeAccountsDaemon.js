// A stand-in for the daemon's `accounts.*` (src-core/src/accounts_doc.rs)
// over a JSON text the test owns (`read()` / `write(text)`), for tests that
// drive db/accounts.js end to end. Same semantics as the Rust module: put
// merges by id or appends, `ifAbsent` skips known ids and logical keys,
// secrets are never written, a version rises on every change. Not the code
// under test: the Rust suite proves the real one.
const SECRETS = ['password', 'oauth2AccessToken', 'oauth2RefreshToken'];
const strip = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !SECRETS.includes(k)));
const key = (a) => `${(a.email || '').toLowerCase()}@${(a.imapHost || a.oauth2Provider || '').toLowerCase()}`;

export function fakeAccountsDaemon({ read, write }) {
  let version = 1;
  const calls = [];
  const list = () => {
    const text = read();
    return text == null ? [] : JSON.parse(text);
  };
  const save = (accounts, changed) => {
    if (!changed.length) return { version, changed };
    version += 1;
    write(JSON.stringify(accounts, null, 2));
    return { version, changed };
  };
  const call = (method, params = {}) => {
    calls.push({ method, params });
    const accounts = list();
    switch (method) {
      case 'accounts.list': return { accounts, version };
      case 'accounts.get': return { account: accounts.find((a) => a.id === params.id) || null, version };
      case 'accounts.put': {
        const entries = (params.entries || [params.entry]).map(strip);
        const changed = [];
        if (params.ifAbsent) {
          const ids = new Set(accounts.map((a) => a.id));
          const keys = new Set(accounts.map(key));
          for (const e of entries) if (!ids.has(e.id) && !keys.has(key(e))) { accounts.push(e); changed.push(e.id); }
        } else {
          for (const e of entries) {
            const at = accounts.findIndex((a) => a.id === e.id);
            if (at >= 0) accounts[at] = { ...accounts[at], ...e }; else accounts.push(e);
            changed.push(e.id);
          }
        }
        return save(accounts, changed);
      }
      case 'accounts.remove': {
        const ids = params.ids || [params.id];
        const kept = accounts.filter((a) => !ids.includes(a.id));
        return save(kept, kept.length === accounts.length ? [] : ids.filter((id) => accounts.some((a) => a.id === id)));
      }
      case 'accounts.replace_all': {
        if (params.baseVersion != null && params.baseVersion !== version) throw new Error('errors.accountsConflict');
        return save(params.entries.map(strip), params.entries.map((e) => e.id));
      }
      default: throw new Error(`fake daemon: ${method}`);
    }
  };
  return { call, calls, version: () => version };
}
