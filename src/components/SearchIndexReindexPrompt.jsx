import React, { useEffect } from 'react';
import { Search } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { useSettingsStore } from '../stores/settingsStore';
import { rebuild } from '../services/searchIndex';
import { daemonCall } from '../services/daemonClient';
import { useT } from '../i18n/index.js';

/**
 * Asked once after an update from a build whose search index and list rows
 * lacked the sender-auth and list headers (settings migrations v11 and v13
 * raise the offer; a new install never has it). Yes rebuilds the index in the
 * daemon, which also parses the list's archived rows again; no leaves both as
 * they are. Either answer is final: the offer is dropped.
 */
export function SearchIndexReindexPrompt() {
  const t = useT();
  const offer = useSettingsStore(s => s.searchIndexReindexOffer);
  const indexOn = useSettingsStore(s => s.searchIndexEnabled);
  const onboarded = useSettingsStore(s => s.onboardingComplete);
  const drop = () => useSettingsStore.setState({ searchIndexReindexOffer: false });

  // An index that is off has nothing stale: turning it on builds it fresh.
  // The list's archived rows are parsed again without asking: that is cheap,
  // lazy, and there is no rebuild to offer.
  useEffect(() => {
    if (!offer || indexOn) return;
    drop();
    daemonCall('vault_reparse_rows', {}).catch(e => console.warn('[searchIndex] row reparse after update failed:', e));
  }, [offer, indexOn]);

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
