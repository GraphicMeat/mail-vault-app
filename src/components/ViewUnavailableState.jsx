import React from 'react';
import { Hourglass, SearchX } from 'lucide-react';
import { useT } from '../i18n/index.js';

/// What the list says while a saved view cannot be worked out. A view reads
/// the search index, and while that is rebuilt the view has nothing to show:
/// a bare empty list there reads as "this view matches nothing", which is a
/// different, and wrong, statement.
export function ViewUnavailableState({ reason }) {
  const t = useT();
  const building = reason === 'building';
  const Icon = building ? Hourglass : SearchX;
  return <div data-testid="view-unavailable-state" data-reason={reason} role="status"
    className="flex flex-col items-center justify-center h-full p-6 text-center text-mail-text-muted">
    <Icon size={48} className="mb-4 opacity-50" aria-hidden="true" />
    <p className="text-mail-text font-medium">
      {building ? t('views.unavailableState.buildingTitle') : t('views.unavailableState.title')}
    </p>
    <p className="text-sm mt-2 max-w-sm">
      {building ? t('views.unavailableState.buildingBody') : t(`views.unavailable.${reason}`)}
    </p>
  </div>;
}
