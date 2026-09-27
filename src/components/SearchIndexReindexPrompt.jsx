import React, { useEffect } from 'react';
import { Search } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { useSettingsStore } from '../stores/settingsStore';
import { rebuild } from '../services/searchIndex';
import { useT } from '../i18n/index.js';

/**
 * Asked once after an update from a build whose search index lacked the
 * sender-auth and list headers (settings migration v11 raises the offer; a new
 * install never has it). Yes rebuilds the index in the daemon, no leaves it as
 * it is. Either answer is final: the offer is dropped.
 */
export function SearchIndexReindexPrompt() {
  const t = useT();
  const offer = useSettingsStore(s => s.searchIndexReindexOffer);
  const indexOn = useSettingsStore(s => s.searchIndexEnabled);
  const onboarded = useSettingsStore(s => s.onboardingComplete);
  const drop = () => useSettingsStore.setState({ searchIndexReindexOffer: false });

  // An index that is off has nothing stale: turning it on builds it fresh.
  useEffect(() => { if (offer && !indexOn) drop(); }, [offer, indexOn]);

  if (!offer || !indexOn || !onboarded) return null;
  return (
    <ConfirmDialog
      isOpen
      icon={(
        <div className="w-10 h-10 rounded-full flex items-center justify-center bg-mail-accent/10">
          <Search size={20} className="text-mail-accent-text" />
        </div>
      )}
      title={t('searchIndex.reindexOffer.title')}
      description={(
        <>
          <p>{t('searchIndex.reindexOffer.why')}</p>
          <p className="mt-2">{t('searchIndex.reindexOffer.how')}</p>
        </>
      )}
      confirmLabel={t('searchIndex.reindexOffer.confirm')}
      cancelLabel={t('searchIndex.reindexOffer.later')}
      onClose={drop}
      onConfirm={() => {
        drop();
        // The daemon rebuilds in the background and reports through the
        // index's own progress; a failure shows in Search index settings.
        rebuild().catch(e => console.warn('[searchIndex] reindex after update failed:', e));
      }}
    />
  );
}
