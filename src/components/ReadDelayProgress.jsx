import React from 'react';
import { useSelectionStore } from '../stores/selectionStore';
import { useT } from '../i18n/index.js';

export function ReadDelayProgress() {
  const t = useT();
  const progress = useSelectionStore(s => s.markReadProgress);
  if (!progress) return null;

  return (
    <div
      role="progressbar"
      aria-label={t('viewer.markingAsRead')}
      aria-valuemin="0"
      aria-valuemax="100"
      className="read-delay-progress"
      style={{ '--read-delay-duration': `${Math.max(0, progress.endsAt - progress.startedAt)}ms` }}
    >
      <span />
    </div>
  );
}
