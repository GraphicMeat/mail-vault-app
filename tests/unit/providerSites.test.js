// Provider-site guard (JMAP Task 11). Every source file that branches on a
// Graph account, by `isGraphAccount(` or a raw `oauth2Transport === 'graph'`,
// must also say what a JMAP account does there: mention `isJmapAccount` or
// `serverSavesSent`, or sit in ALLOWED with a reason. So the next Graph-only
// branch has to say why JMAP does not need one.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { listSourceFiles } from '../../scripts/lib/sourceFiles.mjs';

const GRAPH_SITE = /isGraphAccount\(|oauth2Transport\s*[!=]==?\s*['"]graph['"]/;
const JMAP_AWARE = /isJmapAccount|serverSavesSent/;

const IMAP_PATH = 'Graph-only branch; JMAP takes the IMAP path';
const ALLOWED = {
  // Names a grant's transport for its fingerprint (oauth_tokens.rs); no mail branch.
  'src/services/oauthTokenSync.js': 'grant fingerprint, not a mail branch',
  'src/components/ComposeModal.jsx': IMAP_PATH,
  'src/App.jsx': 'Detached compose admission uses the same follow-up reminder policy; JMAP takes the IMAP path',
  'src/components/settings/MboxImportDialog.jsx': IMAP_PATH,
  'src/components/settings/MigrationSettings.jsx': IMAP_PATH,
  'src/components/settings/VaultGapRow.jsx': IMAP_PATH,
  'src/components/settings/abd/AbdSection.jsx': IMAP_PATH,
  'src/hooks/useEmailScheduler.js': IMAP_PATH,
  'src/services/AccountPipeline.js': IMAP_PATH,
  'src/services/EmailPipelineManager.js': IMAP_PATH,
  'src/services/codeBubble.js': IMAP_PATH,
  'src/services/db/accounts.js': IMAP_PATH,
  'src/services/export/bodyResolver.js': IMAP_PATH,
  'src/services/graphConfig.js': 'Defines isGraphAccount itself',
  'src/services/searchTargets.js': IMAP_PATH,
  'src/services/workflows/activateAccount.js': IMAP_PATH,
  'src/services/workflows/addAccount.js': IMAP_PATH,
  'src/services/workflows/adoptGraphFolderKeys.js': IMAP_PATH,
  'src/services/workflows/folderOps.js': IMAP_PATH,
  'src/services/workflows/folderStatus.js': IMAP_PATH,
  'src/services/workflows/loadEmails.js': IMAP_PATH,
  'src/services/workflows/probeServerCopy.js': IMAP_PATH,
  'src/services/workflows/refreshAccounts.js': IMAP_PATH,
  'src/services/workflows/removeAccount.js': IMAP_PATH,
  'src/services/workflows/replayOps.js': IMAP_PATH,
  'src/services/workflows/selectEmail.js': IMAP_PATH,
  'src/services/workflows/snooze.js': IMAP_PATH,
  'src/services/workflows/updateAccount.js': IMAP_PATH,
};

const FILES = listSourceFiles(['src'], ['.js', '.jsx'], { exclude: ['__tests__', '__mocks__', '.test.', '.spec.'] });
const read = (file) => readFileSync(file, 'utf8');

describe('provider sites', () => {
  it('finds the Graph sites it guards (the scan is not empty)', () => {
    expect(FILES.filter(f => GRAPH_SITE.test(read(f))).length).toBeGreaterThan(20);
  });

  it('every Graph-only branch says what JMAP does there', () => {
    const unexplained = FILES.filter(f => {
      const src = read(f);
      return GRAPH_SITE.test(src) && !JMAP_AWARE.test(src) && !ALLOWED[f];
    });
    expect(unexplained, 'mention isJmapAccount/serverSavesSent, or add the file to ALLOWED with a reason').toEqual([]);
  });

  it('the allowlist holds no stale entry', () => {
    const stale = Object.keys(ALLOWED).filter(f => {
      if (!FILES.includes(f)) return true;
      const src = read(f);
      return !GRAPH_SITE.test(src) || JMAP_AWARE.test(src);
    });
    expect(stale, 'drop these from ALLOWED: gone, no Graph branch left, or JMAP-aware now').toEqual([]);
  });

  it('gives every allowed file a reason', () => {
    expect(Object.entries(ALLOWED).filter(([, why]) => !String(why).trim())).toEqual([]);
  });
});
