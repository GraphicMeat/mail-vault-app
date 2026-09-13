import React, { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '../ui/Button';
import { ToggleSwitch } from './ToggleSwitch';
import { useSettingsStore } from '../../stores/settingsStore';
import { status, rebuild, onProgress } from '../../services/searchIndex';
import { formatBytes } from '../../utils/formatBytes';
import { useT } from '../../i18n/index.js';

export function SearchIndexSettings() {
  const t = useT();
  const bodies = useSettingsStore(s => s.searchIndexBodies);
  const setSearchIndexBodies = useSettingsStore(s => s.setSearchIndexBodies);
  const attachments = useSettingsStore(s => s.searchIndexAttachments);
  const setSearchIndexAttachments = useSettingsStore(s => s.setSearchIndexAttachments);
  const imageText = useSettingsStore(s => s.searchIndexImageText);
  const setSearchIndexImageText = useSettingsStore(s => s.setSearchIndexImageText);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let alive = true;
    let unlisten = null;
    onProgress(p => { if (alive) setInfo(p); }).then(u => { if (alive) unlisten = u; else u(); });
    // A progress event that beat the status reply is the newer of the two.
    status().then(s => { if (alive) setInfo(cur => cur ?? s); });
    return () => { alive = false; unlisten?.(); };
  }, []);

  const indexing = info?.available && info.state === 'indexing';
  const pct = info?.total > 0 ? Math.floor((100 * info.indexed) / info.total) : 0;

  return (
    <div className="settings-section" id="settings-search-index">
      <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
        <Search size={18} className="text-mail-accent-text" />
        {t('settings.searchIndex.title')}
      </h4>
      <p className="text-sm text-mail-text-muted mb-4">{t('settings.searchIndex.description')}</p>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div>
            <div className="text-sm text-mail-text">{t('settings.searchIndex.bodies')}</div>
            <div className="text-xs text-mail-text-muted">{t('settings.searchIndex.bodiesHint')}</div>
          </div>
          <ToggleSwitch active={bodies} onClick={() => setSearchIndexBodies(!bodies)}
            testId="search-index-bodies" label={t('settings.searchIndex.bodies')} />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div>
            <div className="text-sm text-mail-text">{t('settings.searchIndex.attachments')}</div>
            <div className="text-xs text-mail-text-muted">{t('settings.searchIndex.attachmentsHint')}</div>
          </div>
          <ToggleSwitch active={attachments} onClick={() => setSearchIndexAttachments(!attachments)}
            testId="search-index-attachments" label={t('settings.searchIndex.attachments')} />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div>
            <div className="text-sm text-mail-text">{t('settings.searchIndex.imageText')}</div>
            <div className="text-xs text-mail-text-muted">{t('settings.searchIndex.imageTextHint')}</div>
          </div>
          <ToggleSwitch active={imageText} onClick={() => setSearchIndexImageText(!imageText)}
            testId="search-index-image-text" label={t('settings.searchIndex.imageText')} />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div className="flex-1 min-w-0">
            {info?.available ? (
              <>
                <div className="text-sm text-mail-text" data-testid="search-index-status">
                  {t('settings.searchIndex.status', {
                    indexed: (info.indexed || 0).toLocaleString(),
                    total: (info.total || 0).toLocaleString(),
                    size: formatBytes(info.sizeBytes || 0),
                  })}
                </div>
                {indexing && (
                  <>
                    <div className="text-xs text-mail-text-muted">{t('settings.searchIndex.indexing')}</div>
                    <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
                      aria-label={t('settings.searchIndex.indexing')}
                      className="h-1.5 rounded-full bg-mail-border mt-2 overflow-hidden">
                      <div className="h-1.5 rounded-full bg-mail-accent transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </>
                )}
              </>
            ) : info && (
              <div className="text-xs text-mail-text-muted">{t('settings.searchIndex.unavailable')}</div>
            )}
          </div>
          <Button size="sm" data-testid="search-index-rebuild" disabled={!info?.available}
            onClick={() => rebuild().catch(e => console.warn('[searchIndex] rebuild failed:', e))}>
            {t('settings.searchIndex.rebuild')}
          </Button>
        </div>
      </div>
    </div>
  );
}
