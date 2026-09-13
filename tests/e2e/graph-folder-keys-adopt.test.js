/**
 * E2E (Graph conf): directories written under a localized name are adopted.
 *
 * beforeSession (wdio.graph.conf.js) planted, before the app launched, a Sent
 * folder under "Gesendet" with its uid ledger and index and no English twin,
 * and a Trash under "Papierkorb" beside an existing English "Trash". Launch
 * must move the first under `Sent` as a unit and leave the second pair alone.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails } from './helpers.js';
import { appDataDir } from './mockImap.js';
import { GRAPH_ACCOUNT_ID, LEGACY_SENT_DIR, LEGACY_TRASH_DIR, LEGACY_EML } from './mockGraph.js';

describe('Graph folder keys: adopting localized directories', function () {
  this.timeout(120_000);

  const data = () => appDataDir(browser.testDataDir);
  const cacheBase = GRAPH_ACCOUNT_ID.replace(/-/g, '_');
  const maildir = (box) => join(data(), 'Maildir', GRAPH_ACCOUNT_ID, box);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('the seed ran (anti-vacuity)', function () {
    expect(existsSync(join(maildir(LEGACY_TRASH_DIR), 'cur', LEGACY_EML))).toBe(true);
  });

  it('moves a localized Sent, its ledger and its index under the English key', async function () {
    await browser.waitUntil(() => existsSync(join(maildir('Sent'), 'cur', LEGACY_EML)), { timeout: 30_000, timeoutMsg: 'Sent was not adopted' });
    expect(readFileSync(join(data(), 'email_cache', `${cacheBase}_Sent`, 'graph_id_map.json'), 'utf-8')).toContain('msg-fld-sent-1');
    expect(existsSync(join(data(), 'maildir', GRAPH_ACCOUNT_ID, 'Sent', 'local-index.json'))).toBe(true);
    expect(existsSync(maildir(LEGACY_SENT_DIR))).toBe(false);
    expect(existsSync(join(data(), 'email_cache', `${cacheBase}_${LEGACY_SENT_DIR}`))).toBe(false);
  });

  it('leaves both directories alone when the English one already exists', function () {
    expect(readdirSync(join(maildir(LEGACY_TRASH_DIR), 'cur'))).toEqual([LEGACY_EML]);
    expect(existsSync(join(maildir('Trash'), 'cur'))).toBe(true);
    expect(readdirSync(join(maildir('Trash'), 'cur')).filter((n) => n.endsWith('.eml'))).toEqual([]);
  });

  it('remembers the adoption in the settings file', async function () {
    const flag = () => {
      try {
        const s = JSON.parse(readFileSync(join(data(), 'frontend-settings.json'), 'utf-8'));
        return s['mailvault-settings']?.state?.graphFolderKeysAdopted?.[GRAPH_ACCOUNT_ID] === true;
      } catch { return false; }
    };
    await browser.waitUntil(flag, { timeout: 30_000, timeoutMsg: 'graphFolderKeysAdopted never persisted' });
  });
});
