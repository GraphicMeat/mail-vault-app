// ── db.js — facade over the split db/ modules; kept as the stable import path ──
// (17+ call sites across the app import from here.) See src/services/db/ for
// the actual implementation: keychain.js, accounts.js, emails.js, caches.js.

export * from './db/index.js';
