import React, { useEffect, useRef, useState } from 'react';
import { Archive, HardDriveDownload } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsCard } from '../../ui/SettingsForm';
import AbdSetup from './AbdSetup';
import { useSettingsStore, hasPremiumAccess } from '../../../stores/settingsStore';
import { useAccountStore } from '../../../stores/accountStore';
import { useAbdStore } from '../../../stores/abdStore';
import { watchAbd } from '../../../services/abd';
import { MODE_ARCHIVE, MODE_BACKUP, isFinished } from '../../../utils/abdFrame';
import { IS_APPSTORE_BUILD } from '../../../utils/buildFlags';
import { statusText } from '../../abd/abdText';
import { useT } from '../../../i18n/index.js';

const selectClass = 'w-full px-4 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent';

function PremiumBadge() {
  const t = useT();
  return (
    <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase tracking-wider bg-mail-accent-fill text-white rounded-full">
      {t('common.premium')}
    </span>
  );
}

/**
 * Settings > Backup & Restore > Archive & delete (part-d design 6.2): the two
 * jobs that save mail here and then take it off the server. Both are Premium.
 * "Archive, back up & delete" needs a backup folder, because it never deletes
 * on a vault-only copy; "Archive & delete" says its vault is the only copy.
 */
export default function AbdSection({ onUpgrade }) {
  const t = useT();
  const accounts = useAccountStore(s => s.accounts);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const premium = useSettingsStore(s => hasPremiumAccess(s.billingProfile));
  const backupLocation = useSettingsStore(s => s.externalBackupLocation);
  const jobs = useAbdStore(s => s.jobs);

  const visible = getOrderedAccounts(accounts || []).filter(a => !hiddenAccounts?.[a.id]);
  const [accountId, setAccountId] = useState(null);
  const [setup, setSetup] = useState(null); // the mode being set up, or null
  const [upsell, setUpsell] = useState(null); // the mode whose Set up was pressed without Premium
  const [pointAtBackup, setPointAtBackup] = useState(false);
  const backupCard = useRef(null);

  // This may be a Settings window of its own: follow the job's frames there too.
  useEffect(() => {
    let stop = () => {};
    let gone = false;
    watchAbd().then(off => { if (gone) off(); else stop = off; });
    return () => { gone = true; stop(); };
  }, []);

  const account = visible.find(a => a.id === accountId) || visible[0] || null;
  if (!account) {
    return (
      <SettingsCard data-testid="abd-no-accounts" className="text-center">
        <p className="text-sm text-mail-text-muted">{t('common.noAccountsConfigured')}</p>
      </SettingsCard>
    );
  }

  const job = jobs[account.id];
  const running = !!job && !isFinished(job);
  const backupReady = backupLocation?.status === 'ready';
  const graph = account.oauth2Transport === 'graph';

  if (setup) {
    return (
      <AbdSetup account={account} mode={setup} onBack={() => setSetup(null)} onStarted={() => setSetup(null)} />
    );
  }

  const openSetup = (mode) => {
    if (!premium) { setUpsell(mode); return; }
    setUpsell(null);
    setSetup(mode);
  };

  // "Your vault will be the only copy": the way out is the other card.
  const chooseBackup = () => {
    setPointAtBackup(true);
    backupCard.current?.scrollIntoView?.({ block: 'nearest' });
    backupCard.current?.focus?.({ preventScroll: true });
  };

  const upsellBox = (mode) => upsell === mode && !premium && (
    <div data-testid="abd-upsell" className="border border-mail-accent/30 bg-mail-accent/5 rounded-xl p-4">
      <p className="text-sm text-mail-text">{t('settings.backup.abd.upsell')}</p>
      {!IS_APPSTORE_BUILD && onUpgrade && (
        <Button variant="primary" size="sm" className="mt-3" data-testid="abd-upgrade" onClick={onUpgrade}>
          {t('common.upgrade')}
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-6" data-testid="abd-section">
      <p className="text-sm text-mail-text-muted">{t('settings.backup.abd.intro')}</p>

      <div>
        <label htmlFor="abd-account" className="text-xs text-mail-text-muted mb-1 block">{t('settings.backup.abd.account')}</label>
        <select id="abd-account" data-testid="abd-account" className={selectClass} value={account.id}
          onChange={e => { setAccountId(e.target.value); setUpsell(null); }}>
          {visible.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}
        </select>
        {graph && <p className="mt-2 text-xs text-mail-text-muted" data-testid="abd-graph-hint">{t('settings.backup.abd.graphHint')}</p>}
      </div>

      {job && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-mail-bg p-3" data-testid="abd-job-line">
          <p className="text-sm text-mail-text">{running ? t('settings.backup.abd.jobRunning') : statusText(job)}</p>
          <Button variant="accentTint" size="sm" data-testid="abd-show-progress" onClick={() => useAbdStore.getState().openPanel(account.id)}>
            {t('settings.backup.abd.showProgress')}
          </Button>
        </div>
      )}

      <div ref={backupCard} tabIndex={-1} data-testid="abd-backup-wrap" data-pointed={pointAtBackup || undefined}
        className={pointAtBackup ? 'rounded-xl ring-1 ring-mail-accent' : ''}>
        <SettingsCard data-testid="abd-card-backup" icon={HardDriveDownload} badge={<PremiumBadge />} headingClassName="mb-2"
          title={t('settings.backup.abd.backupCard.title')}>
          <div className="space-y-3">
            <p className="text-sm text-mail-text-muted">{t('settings.backup.abd.backupCard.desc')}</p>
            {!backupReady && <p className="text-xs text-mail-warning" data-testid="abd-needs-backup">{t('settings.backup.abd.needsBackupFolder')}</p>}
            {upsellBox(MODE_BACKUP)}
            <Button variant="primary" size="sm" data-testid="abd-setup-backup" disabled={!backupReady || running}
              onClick={() => openSetup(MODE_BACKUP)}>
              {t('settings.backup.abd.setUp')}
            </Button>
          </div>
        </SettingsCard>
      </div>

      <SettingsCard data-testid="abd-card-archive" icon={Archive} badge={<PremiumBadge />} headingClassName="mb-2"
        title={t('settings.backup.abd.archiveCard.title')}>
        <div className="space-y-3">
          <p className="text-sm text-mail-text-muted">{t('settings.backup.abd.archiveCard.desc')}</p>
          <p className="text-xs text-mail-text-muted" data-testid="abd-only-copy">
            {t('settings.backup.abd.onlyCopyNote')}{' '}
            <Button variant="link" size="xs" data-testid="abd-use-backup" onClick={chooseBackup}>
              {t('settings.backup.abd.useBackupInstead')}
            </Button>
          </p>
          {upsellBox(MODE_ARCHIVE)}
          <Button variant="primary" size="sm" data-testid="abd-setup-archive" disabled={running}
            onClick={() => openSetup(MODE_ARCHIVE)}>
            {t('settings.backup.abd.setUp')}
          </Button>
        </div>
      </SettingsCard>
    </div>
  );
}
