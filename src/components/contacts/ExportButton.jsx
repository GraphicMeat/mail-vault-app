import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { useT } from '../../i18n';
import { exportContacts } from '../../services/contactsExport';
import { Button } from '../ui/Button';

export function ExportButton() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState(null);
  const run = async () => {
    setBusy(true);
    setErrorKey(null);
    try {
      const r = await exportContacts(t);
      if (!r.ok && !r.cancelled) setErrorKey(r.errorKey);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" data-testid="contacts-export" loading={busy} onClick={run}><Download size={16} /> {t('contacts.export')}</Button>
      {errorKey && <span role="alert" data-testid="contacts-export-error" className="text-xs text-red-600">{t(errorKey)}</span>}
    </>
  );
}
