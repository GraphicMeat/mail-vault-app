// @vitest-environment node
// A Microsoft account's transport (Graph or IMAP) is chosen once, when the
// account is added: Automatic picks Graph for a personal address, but the
// user may pick IMAP. Nothing after the add may read the address's domain and
// override that choice (the old auto-repairs flipped an IMAP pick to Graph on
// every load). The domain check lives only where Automatic resolves.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

vi.mock('../../i18n/index.js', () => ({ t: (k) => k }));
const { oauthSignInFailedMessage } = await import('../graphConfig.js');

const SRC = join(__dirname, '..', '..');
const ALLOWED = new Set(['components/AccountModal.jsx', 'services/graphConfig.js']);

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.(jsx?|mjs)$/.test(name) ? [path] : [];
  });
}

describe('a Microsoft account keeps the transport it was added with', () => {
  it('only the add-account flow reads the personal-domain list', () => {
    const readers = sources(SRC)
      .filter((path) => /isPersonalMicrosoftEmail|PERSONAL_MS_DOMAINS/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .filter((path) => !ALLOWED.has(path));
    expect(readers).toEqual([]);
  });

  it('a failed sign-in names Graph only for a Graph account, whatever the domain', () => {
    expect(oauthSignInFailedMessage({ email: 'me@outlook.com', oauth2Transport: 'graph' })).toMatch(/Graph/);
    expect(oauthSignInFailedMessage({ email: 'me@outlook.com', oauth2Transport: 'imap' })).not.toMatch(/Graph/);
    expect(oauthSignInFailedMessage({ email: 'me@contoso.example', oauth2Transport: 'imap' })).not.toMatch(/Graph/);
  });
});
