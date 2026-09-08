import React, { useEffect, useState } from 'react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';

/**
 * One text field for a folder's name: creating one, or renaming one.
 *
 * The name is validated where it is used, not here — `folderOps.validName`
 * knows the account's delimiter — so a bad name comes back as the app's error
 * toast rather than as a second copy of the rule in this file.
 */
export function FolderNameDialog({ open, title, initial = '', confirmLabel, onSubmit, onClose }) {
  const t = useT();
  const [name, setName] = useState(initial);

  // The dialog is kept mounted between openings, so the field has to be reset
  // when it opens rather than only on first render.
  useEffect(() => { if (open) setName(initial); }, [open, initial]);

  const submit = () => {
    if (!name.trim()) return;
    onSubmit(name);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" className="flex-1" disabled={!name.trim()} onClick={submit}>{confirmLabel}</Button>
        </>
      }
    >
      <input
        autoFocus
        data-autofocus
        type="text"
        data-testid="folder-name-input"
        aria-label={t('sidebar.folderName')}
        placeholder={t('sidebar.folderName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        className="w-full px-3 py-2 rounded-lg bg-mail-surface border border-mail-border
                   text-sm text-mail-text placeholder:text-mail-text-muted"
      />
    </Dialog>
  );
}
