import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const AUDIT = resolve(process.cwd(), 'scripts/i18n-audit.mjs');

// Every task appends the files it drained. A file listed here can never regress.
const DONE = [
  'src/components/Sidebar.jsx',
  'src/components/settings/StorageSettings.jsx',
  'src/components/settings/AppearanceSettings.jsx',
  'src/components/settings/MailStorageLocation.jsx',
  'src/components/settings/AccountSettings.jsx',
  'src/components/settings/AISettings.jsx',
  'src/components/settings/SendAsVerifyModal.jsx',
  'src/components/settings/MigrationSettings.jsx',
  'src/components/settings/BehaviorSettings.jsx',
  'src/components/settings/ShortcutsSettings.jsx',
  'src/components/settings/BillingSettings.jsx',
  'src/components/settings/BackupAccountCard.jsx',
  'src/components/settings/BackupConfig.jsx',
  'src/components/settings/BackupRestore.jsx',
  'src/components/settings/BackupSchedule.jsx',
  'src/components/settings/BackupVerificationTree.jsx',
];

function audit(mode, files) {
  try {
    execFileSync('node', [AUDIT, mode, ...files], { encoding: 'utf8' });
    return '';
  } catch (e) {
    return e.stdout || String(e);
  }
}

describe('extracted files stay drained', () => {
  it('has no hardcoded JSX strings left', () => {
    expect(audit('strings', DONE)).toBe('');
  });

  it('has no component calling t() without useT()', () => {
    expect(audit('hooks', DONE)).toBe('');
  });
});
