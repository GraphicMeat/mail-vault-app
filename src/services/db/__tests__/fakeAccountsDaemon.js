// A stand-in for the daemon's `accounts.*` (src-core/src/accounts_doc.rs)
// over a JSON text the test owns (`read()` / `write(text)`), for tests that
// drive db/accounts.js end to end. Same semantics as the Rust module: put
// merges by id or appends, `ifAbsent` skips known ids and logical keys,
// secrets are never written, a version rises on every change. Not the code
// under test: the Rust suite proves the real one.
const SECRETS = ['password', 'oauth2AccessToken', 'oauth2RefreshToken'];
const strip = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !SECRETS.includes(k)));
const key = (a) => `${(a.email || '').toLowerCase()}@${(a.imapHost || a.oauth2Provider || '').toLowerCase()}`;

export function fakeAccountsDaemon({ read, write, credentials }) {
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
      case 'accounts.save': {
        if (!credentials) throw new Error('errors.daemonOutdated');
        // Synthetic native persistence boundary; literal JS caller assertions
        // and the real Rust route suites independently define the contract.
        const before = credentials.read();
        const next = { ...before };
        const current = new Map(accounts.map(a => [a.id, { ...a }]));
        for (const [id, raw] of Object.entries(before)) current.set(id, { ...current.get(id), ...JSON.parse(raw), id });
        const rows = [], accepted = [], skipped = {};
        let hostChanged = false;
        if (params.patch) {
          const { id, fields, unset = [], expected } = params.patch;
          const old = current.get(id);
          if (!old || (expected?.credentialPresent && !Object.hasOwn(before, id))
            || Object.entries(expected?.fields || {}).some(([k, v]) => JSON.stringify(old[k]) !== JSON.stringify(v))
            || (expected?.absent || []).some(k => Object.hasOwn(old, k))) throw new Error('errors.accountsConflict');
          const value = { ...old, ...fields };
          for (const k of unset) delete value[k];
          if (old.imapHost && value.imapHost && old.imapHost !== value.imapHost) {
            value.previousImapHost = old.imapHost; value.hostChangedAt = Date.now(); hostChanged = true;
          }
          if ([...current].some(([other, a]) => other !== id && key(a) === key(value))) throw new Error('errors.accountsConflict');
          if (Object.hasOwn(before, id) || SECRETS.some(k => Object.hasOwn(fields, k))) next[id] = JSON.stringify(value);
          rows.push(strip(value)); accepted.push(id);
        } else for (const entry of params.entries) {
          const old = current.get(entry.id);
          const match = [...current].find(([, a]) => key(a) === key(entry));
          if (old && (!params.ifAbsent || key(old) !== key(entry)) || match && !params.ifAbsent) throw new Error('errors.accountsConflict');
          if (match) { skipped[entry.id] = match[0]; continue; }
          current.set(entry.id, entry); next[entry.id] = JSON.stringify(entry);
          rows.push(strip(entry)); accepted.push(entry.id);
        }
        credentials.write(next);
        for (const row of rows) {
          const at = accounts.findIndex(a => a.id === row.id);
          if (at < 0) accounts.push(row); else accounts[at] = row;
        }
        const result = save(accounts, rows.map(a => a.id));
        return { accounts: rows, accepted, skipped, version: result.version, credentialVersion: credentials.version(), hostChanged };
      }
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
