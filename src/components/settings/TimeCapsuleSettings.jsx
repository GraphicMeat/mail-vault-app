import React from 'react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { Clock, Lock, Info } from 'lucide-react';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';
import { useT } from '../../i18n/index.js';

export function TimeCapsuleSettings() {
  const t = useT();
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPremium = hasPremiumAccess(billingProfile);
  const snapshotAutoEnabled = useSettingsStore(s => s.snapshotAutoEnabled);
  const snapshotCadence = useSettingsStore(s => s.snapshotCadence);
  const setSnapshotAutoEnabled = useSettingsStore(s => s.setSnapshotAutoEnabled);
  const setSnapshotCadence = useSettingsStore(s => s.setSnapshotCadence);

  if (!isPremium) {
    return (
      <div className="p-6">
        <div className="bg-mail-surface border border-mail-border rounded-xl p-8 text-center">
          <Lock size={32} className="text-mail-text-muted mx-auto mb-4" />
          <h3 className="text-sm font-semibold text-mail-text mb-2">{t('settings.timeCapsule.timeCapsuleRequiresPremium')}</h3>
          <p className="text-xs text-mail-text-muted max-w-md mx-auto">
            {t('settings.timeCapsule.travelBackTimeThroughMailbox')}
          </p>
          <PremiumFeaturesLink className="mt-4" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Explainer */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-mail-accent/10 flex items-center justify-center">
            <Info size={20} className="text-mail-accent-text" />
          </div>
          <h3 className="text-sm font-semibold text-mail-text">{t('settings.timeCapsule.howTimeCapsuleWorks')}</h3>
        </div>
        <p className="text-xs text-mail-text-muted mb-2">
          {t('settings.timeCapsule.timeCapsuleLetsTravelBack')}
        </p>
        <p className="text-xs text-mail-text-muted">
          {t('settings.timeCapsule.actualEmailsAlreadyStoredLocally')} <em>{t('settings.timeCapsule.whatWasThereWhen')}</em>, so they take up very little space (a few hundred KB each). If you ever accidentally delete or lose an email, you can open a past snapshot, find it, and restore it.
        </p>
      </div>

      {/* Auto snapshots toggle */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-mail-accent/10 flex items-center justify-center">
            <Clock size={20} className="text-mail-accent-text" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-mail-text">{t('settings.timeCapsule.automaticSnapshots')}</h3>
            <p className="text-xs text-mail-text-muted">{t('settings.timeCapsule.snapshotsCreatedAfterSuccessfulBackups')}</p>
          </div>
        </div>

        <label className="flex items-center justify-between p-3 rounded-lg border border-mail-border mb-4 cursor-pointer hover:bg-mail-surface-hover transition-colors">
          <div>
            <p className="text-sm font-medium text-mail-text">{t('settings.timeCapsule.enableAutomaticSnapshots')}</p>
            <p className="text-xs text-mail-text-muted">{t('settings.timeCapsule.whenDisabledSnapshotsOnlyCreated')}</p>
          </div>
          <input
            type="checkbox"
            checked={snapshotAutoEnabled}
            onChange={e => setSnapshotAutoEnabled(e.target.checked)}
            className="w-4 h-4 accent-mail-accent"
          />
        </label>

        {/* Cadence selector */}
        {snapshotAutoEnabled && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-mail-text-muted uppercase tracking-wide px-1">{t('settings.timeCapsule.snapshotFrequency')}</p>

            <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              snapshotCadence === 'after_every_backup' ? 'border-mail-accent bg-mail-accent/5' : 'border-mail-border hover:bg-mail-surface-hover'
            }`}>
              <input
                type="radio"
                name="snapshotCadence"
                checked={snapshotCadence === 'after_every_backup'}
                onChange={() => setSnapshotCadence('after_every_backup')}
                className="mt-0.5 accent-mail-accent"
              />
              <div>
                <p className="text-sm font-medium text-mail-text">{t('settings.timeCapsule.afterEveryBackup')}</p>
                <p className="text-xs text-mail-text-muted">{t('settings.timeCapsule.snapshotCreatedEveryTimeBackup')}</p>
              </div>
            </label>

            <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              snapshotCadence === 'daily' ? 'border-mail-accent bg-mail-accent/5' : 'border-mail-border hover:bg-mail-surface-hover'
            }`}>
              <input
                type="radio"
                name="snapshotCadence"
                checked={snapshotCadence === 'daily'}
                onChange={() => setSnapshotCadence('daily')}
                className="mt-0.5 accent-mail-accent"
              />
              <div>
                <p className="text-sm font-medium text-mail-text">{t('settings.timeCapsule.daily')}</p>
                <p className="text-xs text-mail-text-muted">{t('settings.timeCapsule.mostOneSnapshotPerAccount')}</p>
              </div>
            </label>

            <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              snapshotCadence === 'weekly' ? 'border-mail-accent bg-mail-accent/5' : 'border-mail-border hover:bg-mail-surface-hover'
            }`}>
              <input
                type="radio"
                name="snapshotCadence"
                checked={snapshotCadence === 'weekly'}
                onChange={() => setSnapshotCadence('weekly')}
                className="mt-0.5 accent-mail-accent"
              />
              <div>
                <p className="text-sm font-medium text-mail-text">{t('settings.timeCapsule.weekly')}</p>
                <p className="text-xs text-mail-text-muted">{t('settings.timeCapsule.mostOneSnapshotPerAccount2')}</p>
              </div>
            </label>
          </div>
        )}
      </div>

      {/* Info note */}
      <p className="text-xs text-mail-text-muted">
        You can always take a manual snapshot from the Time Capsule panel regardless of these settings. Snapshots are lightweight (a few hundred KB each) and stored locally.
      </p>
    </div>
  );
}
