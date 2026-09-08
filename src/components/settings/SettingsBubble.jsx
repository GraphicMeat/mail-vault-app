import React, { useEffect, useRef } from 'react';
import { Settings, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { useT } from '../../i18n';
import '../../styles/settings-usability.css';

/** A minimized Settings session shares Compose's corner stack. */
export function SettingsBubble({ location, onRestore, onClose }) {
  const t = useT();
  const restoreRef = useRef(null);
  useEffect(() => { restoreRef.current?.focus({ preventScroll: true }); }, []);
  return <div className="settings-bubble" data-testid="settings-bubble">
    <button ref={restoreRef} type="button" className="settings-bubble-restore"
      onClick={() => onRestore()} aria-label={t('settingsPage.restore')}
      title={[t('settingsPage.restore'), location].filter(Boolean).join(' · ')}>
      <span className="settings-bubble-icon"><Settings size={16} aria-hidden="true" /></span>
      <span className="settings-bubble-copy">
        <span>{t('settingsPage.settings')}</span>
        {location && <small>{location}</small>}
      </span>
    </button>
    <Button variant="ghost" icon size="sm" onClick={onClose}
      aria-label={t('settingsPage.close')} title={t('settingsPage.close')}>
      <X size={16} aria-hidden="true" />
    </Button>
  </div>;
}
