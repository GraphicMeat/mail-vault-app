// Desktop's folder colour palette (components/FolderColorPalette.jsx: the same swatches and the
// same "Default" as its folder context menu) in a sheet, for one folder of one account. A pick is
// saved in the phone's `folderIconColors`; Default takes it away, back to the style's colour.
import React from 'react';
import Sheet from '../Sheet.jsx';
import { useT } from '../i18n.js';
import { folderLabel } from '../folders.js';
import { useMobileStore } from '../store.js';
import { FolderColorPalette } from '../../components/FolderColorPalette.jsx';
import { haptic } from '../haptics.js';
import { phoneFolderColor, withFolderPick } from './folderColor.js';

export default function FolderColorSheet({ folder, accountId, onClose }) {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const current = phoneFolderColor(folder, accountId, prefs);
  const save = (color) => {
    haptic.selection();
    useMobileStore.getState().setPrefs({ folderIconColors: withFolderPick(prefs, folder, accountId, color) });
    onClose();
  };
  return (
    <Sheet kind="sheet" label={t('sidebar.folderIconColor')} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title" dir="auto">{folderLabel(folder)}</h2>
      <FolderColorPalette
        label={t('sidebar.folderIconColor')}
        resetLabel={t('sidebar.folderIconColorDefault')}
        current={current}
        showLabel={false}
        onPick={save}
        className="mv-palette"
        swatchClassName="mv-swatch"
        resetClassName="mv-palette__reset"
      />
    </Sheet>
  );
}
