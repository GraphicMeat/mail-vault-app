import React from 'react';
import { useT } from '../../i18n/index.js';
import { registerPopoverLayer } from '../../hooks/useDialogA11y';
import { SettingsViewProvider } from '../settings/views/viewContext';
import { TypeaheadChipsView } from '../settings/views/TypeaheadChipsView';

/**
 * Tom Select's typeahead multi-select, without the library (settings/views/TypeaheadChipsView.jsx,
 * which both apps render), with desktop's translator and Escape stack: an open list is a layer
 * of its own, so Escape peels it and leaves the Settings dialog alone. Props as the view's.
 */
export function TypeaheadChips(props) {
  const t = useT();
  return <SettingsViewProvider t={t} registerPopoverLayer={registerPopoverLayer}>
    <TypeaheadChipsView {...props} />
  </SettingsViewProvider>;
}
