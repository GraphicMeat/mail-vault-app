import React from 'react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { Clock, Lock, Info } from 'lucide-react';

export function TimeCapsuleSettings() {
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
          <h3 className="text-sm font-semibold text-mail-text mb-2">Time Capsule Requires Premium</h3>
          <p className="text-xs text-mail-text-muted max-w-md mx-auto">
            Point-in-time mailbox snapshots, browsable history, and email restoration are available with a Premium subscription.
          </p>
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
            <Info size={20} className="text-mail-accent" />
          </div>
          <h3 className="text-sm font-semibold text-mail-text">What are snapshots?</h3>
        </div>
        <p className="text-xs text-mail-text-muted">
          A snapshot is a lightweight record of which emails existed in your mailbox at a specific point in time. The actual email files are already stored locally by MailVault — snapshots just track <em>what was there when</em>. You can browse any snapshot to see your mailbox as it was on that date, and restore individual emails if needed.
        </p>
      </div>

      {/* Auto snapshots toggle */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-mail-accent/10 flex items-center justify-center">
            <Clock size={20} className="text-mail-accent" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-mail-text">Automatic Snapshots</h3>
            <p className="text-xs text-mail-text-muted">Snapshots are created after successful backups based on your schedule.</p>
          </div>
        </div>

        <label className="flex items-center justify-between p-3 rounded-lg border border-mail-border mb-4 cursor-pointer hover:bg-mail-surface-hover transition-colors">
          <div>
            <p className="text-sm font-medium text-mail-text">Enable automatic snapshots</p>
            <p className="text-xs text-mail-text-muted">When disabled, snapshots are only created manually from Time Capsule.</p>
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
            <p className="text-xs font-semibold text-mail-text-muted uppercase tracking-wide px-1">Snapshot frequency</p>

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
                <p className="text-sm font-medium text-mail-text">After every backup</p>
                <p className="text-xs text-mail-text-muted">A snapshot is created every time a backup completes successfully. Most complete history.</p>
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
                <p className="text-sm font-medium text-mail-text">Daily</p>
                <p className="text-xs text-mail-text-muted">At most one snapshot per account per day, even if multiple backups run. Good balance of history and storage.</p>
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
                <p className="text-sm font-medium text-mail-text">Weekly</p>
                <p className="text-xs text-mail-text-muted">At most one snapshot per account per week. Minimal storage, coarser history.</p>
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
