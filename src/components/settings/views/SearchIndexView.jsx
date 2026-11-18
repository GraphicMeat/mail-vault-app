// Settings > Storage > Search index as a view: what the index holds (message bodies, attachment
// text, and on desktop image text and how many mailboxes a search reads at once), its state with
// Rebuild (or Build while it is off), and Delete where the app can delete it.
//
// - `enabled`, `bodies`, `attachments`: the switches; `onBodies()`, `onAttachments()` flip one.
// - `info`: the index's status `{ available, state, indexed, total, sizeBytes, errorKey, error,
//   errorDetail }`; `error`: a catalog key of the last action's failure.
// - `description`, `hints.{bodies, attachments}`: the app's own words (desktop's by default);
//   `messages.recovering`: what an unavailable index says.
// - `imageText` (`{ value, onToggle }`) and `concurrency` (`{ value, isPremium, onChange }`):
//   rows only desktop has. `onUpgrade` links the word "Premium" in a hint. `onDelete` shows Delete.
// - `children`: rendered last inside the section (desktop's delete confirmation).
import React from 'react';
import { Search } from 'lucide-react';
import { Button } from '../../ui/Button';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { useT, useViewEnv } from './viewContext';

const PREMIUM_MARKER = 'premium';

export function SearchIndexView({
  description, hints = {}, messages = {}, enabled, bodies, attachments, onBodies, onAttachments,
  imageText = null, concurrency = null, info, error = null, onRebuild, onDelete = null, onUpgrade = null, children = null,
}) {
  const t = useT();
  const { formatBytes, locale } = useViewEnv();
  const formatCount = (n) => Number(n).toLocaleString(locale);
  const indexing = info?.available && !info.errorKey && !info.error && info.state === 'indexing';
  const pct = info?.total > 0 ? Math.floor((100 * info.indexed) / info.total) : 0;
  const premiumLabel = t('common.premium');

  const renderPremiumHint = key => {
    const text = t(key, { premium: PREMIUM_MARKER });
    const parts = text.split(PREMIUM_MARKER);
    return parts.map((part, index) => (
      <React.Fragment key={`${key}-${index}`}>
        {part}
        {index < parts.length - 1 && (onUpgrade ? (
          <button
            type="button"
            data-testid="search-index-premium-link"
            aria-label={premiumLabel}
            onClick={onUpgrade}
            className="inline cursor-pointer p-0 text-mail-accent-text underline underline-offset-2 hover:text-mail-accent-hover"
          >
            {premiumLabel}
          </button>
        ) : premiumLabel)}
      </React.Fragment>
    ));
  };

  const statusErrorKey = info?.errorKey || info?.error;
  const hasStatusError = !!statusErrorKey || info?.state === 'error';
  const statusMessage = statusErrorKey
    ? t(statusErrorKey)
    : info?.state === 'starting'
      ? t('settings.searchIndex.starting')
      : info?.state === 'error'
        ? t('searchIndex.recoveryFailed')
        : messages.recovering ?? t('settings.searchIndex.recovering');
  const errorDetail = info?.errorDetail;

  return (
    <div className="settings-section" id="settings-search-index">
      <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
        <Search size={18} className="text-mail-accent-text" />
        {t('settings.searchIndex.title')}
      </h4>
      <p className="text-sm text-mail-text-muted mb-4">{description ?? t('settings.searchIndex.description')}</p>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div>
            <div className="text-sm text-mail-text">{t('settings.searchIndex.bodies')}</div>
            <div className="text-xs text-mail-text-muted">{hints.bodies ?? t('settings.searchIndex.bodiesHint')}</div>
          </div>
          <ToggleSwitch active={enabled && bodies} disabled={!enabled} onClick={onBodies}
            testId="search-index-bodies" label={t('settings.searchIndex.bodies')} />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div>
            <div className="text-sm text-mail-text">{t('settings.searchIndex.attachments')}</div>
            <div className="text-xs text-mail-text-muted">{hints.attachments ?? renderPremiumHint('settings.searchIndex.attachmentsHint')}</div>
          </div>
          <ToggleSwitch active={enabled && attachments} disabled={!enabled} onClick={onAttachments}
            testId="search-index-attachments" label={t('settings.searchIndex.attachments')} />
        </div>

        {imageText && (
          <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
            <div>
              <div className="text-sm text-mail-text">{t('settings.searchIndex.imageText')}</div>
              <div className="text-xs text-mail-text-muted">{renderPremiumHint('settings.searchIndex.imageTextHint')}</div>
            </div>
            <ToggleSwitch active={enabled && imageText.value} disabled={!enabled} onClick={imageText.onToggle}
              testId="search-index-image-text" label={t('settings.searchIndex.imageText')} />
          </div>
        )}

        {concurrency && (
          <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
            <div className="min-w-0">
              <div className="text-sm text-mail-text">{t('settings.searchIndex.concurrency')}</div>
              <div className="text-xs text-mail-text-muted">
                {renderPremiumHint(concurrency.isPremium ? 'settings.searchIndex.concurrencyHint' : 'settings.searchIndex.concurrencyFree')}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <select
                data-testid="search-mailbox-concurrency"
                aria-label={t('settings.searchIndex.concurrency')}
                value={concurrency.value}
                disabled={!concurrency.isPremium}
                onChange={e => concurrency.onChange(Number(e.target.value))}
                className="rounded-lg border border-mail-border bg-mail-surface px-3 py-1.5 text-sm text-mail-text disabled:opacity-70"
              >
                {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              {!concurrency.isPremium && onUpgrade && (
                <Button size="sm" variant="primary" data-testid="search-concurrency-upgrade" onClick={onUpgrade}>
                  {t('search.fallback.upgrade')}
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div className="flex-1 min-w-0">
            {!enabled && !hasStatusError ? (
              <div className="text-xs text-mail-text-muted" data-testid="search-index-off">
                {t('settings.searchIndex.off')}
              </div>
            ) : info?.available && !hasStatusError ? (
              <>
                <div className="text-sm text-mail-text" data-testid="search-index-status">
                  {t('settings.searchIndex.status', {
                    indexed: formatCount(info.indexed || 0),
                    total: formatCount(info.total || 0),
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
              <div className="text-xs text-mail-text-muted" data-testid="search-index-status-message" role={statusErrorKey ? 'alert' : undefined}>
                <span>{statusMessage}</span>
                {errorDetail && errorDetail !== statusMessage && errorDetail !== statusErrorKey && (
                  <span>{` ${errorDetail}`}</span>
                )}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {enabled ? (
              <Button size="sm" data-testid="search-index-rebuild" onClick={onRebuild}>
                {t('settings.searchIndex.rebuild')}
              </Button>
            ) : (
              <Button size="sm" data-testid="search-index-build" onClick={onRebuild}>
                {t('settings.searchIndex.build')}
              </Button>
            )}
            {onDelete && (
              <Button size="sm" variant="dangerTint" data-testid="search-index-delete" onClick={onDelete}>
                {t('settings.searchIndex.delete')}
              </Button>
            )}
          </div>
        </div>
        {error && (
          <div className="text-xs text-mail-danger mt-2" role="alert" data-testid="search-index-error">
            {t(error)}
          </div>
        )}
      </div>

      {children}
    </div>
  );
}
