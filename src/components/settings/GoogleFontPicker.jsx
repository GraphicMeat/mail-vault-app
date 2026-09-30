import React, { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Trash2 } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Z } from '../ui/layers';
import { useT } from '../../i18n/index.js';
import { GOOGLE_FONT_CATEGORIES, searchGoogleFonts, uiFontStack } from '../../utils/googleFonts';
import { downloadFont, fontStatus, refreshFonts, removeFont, useFontStore } from '../../services/fontService';

// Rows drawn at once: the catalogue is ~130 names, and a search narrows it.
const SHOWN = 60;

const CATEGORY_KEYS = {
  sans: 'fonts.category.sans',
  serif: 'fonts.category.serif',
  mono: 'fonts.category.mono',
  display: 'fonts.category.display',
  handwriting: 'fonts.category.handwriting',
};
const ERROR_KEYS = { E_FONT_OFFLINE: 'fonts.error.offline' };
/** The message for a failed download's code. */
export const fontErrorText = (t, code) => t(ERROR_KEYS[code] || 'fonts.error.failed');

/**
 * `pick(family)` downloads the family when it is not downloaded yet, then
 * hands it to `apply`. The download runs in the daemon and never blocks:
 * its progress and any failure show in the store the picker renders, and a
 * failure is not an exception here.
 */
export function useGoogleFontChoice(apply) {
  return async family => {
    try {
      await downloadFont(family);
    } catch {
      return;
    }
    apply(family);
  };
}

function FontRow({ font, status, onChoose, onRemove }) {
  const t = useT();
  const ready = status.state === 'ready';
  const error = status.state === 'failed' && fontErrorText(t, status.errorCode);
  return (
    <li data-testid={`google-font-${font.family}`} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-mail-surface-hover">
      <button type="button" onClick={() => onChoose(font.family)} className="flex-1 min-w-0 flex items-baseline gap-2 text-left">
        {/* Drawn in its own face once downloaded; the fallback until then. */}
        <span data-font-name className="truncate text-base text-mail-text" style={{ fontFamily: ready ? uiFontStack(font.family) : undefined }}>{font.family}</span>
        <span className="text-xs text-mail-text-muted">{t(CATEGORY_KEYS[font.category])}</span>
      </button>
      {status.state === 'downloading' && (
        <span role="status" className="flex items-center gap-1 text-xs text-mail-text-muted">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />{t('fonts.picker.downloading')}
        </span>
      )}
      {error && (
        <span className="flex items-center gap-1 text-xs text-mail-danger">
          {error}
          <Button variant="link" size="xs" onClick={() => onChoose(font.family)}>{t('common.retry')}</Button>
        </span>
      )}
      {ready && (
        <>
          <span className="flex items-center gap-1 text-xs text-mail-text-muted"><Check size={12} aria-hidden="true" />{t('fonts.picker.downloaded')}</span>
          <Button variant="ghost" size="xs" icon aria-label={t('fonts.picker.remove', { family: font.family })}
            title={t('fonts.picker.remove', { family: font.family })} onClick={() => onRemove(font.family)}>
            <Trash2 size={13} />
          </Button>
        </>
      )}
    </li>
  );
}

/**
 * The Google Fonts catalogue: searchable, by category, browsed with no
 * network (the list is bundled). Choosing a family downloads it once through
 * the daemon, then `onPick(family)`. `onChoose(family)` hears the click
 * itself, so a caller can keep showing a download the picker was closed on.
 * `onRemoved(family)` after a removal.
 */
export function GoogleFontPicker({ open, onClose, onPick, onChoose, onRemoved }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(null);
  const store = useFontStore();
  const pick = useGoogleFontChoice(family => onPick?.(family));
  const choose = family => { onChoose?.(family); return pick(family); };

  useEffect(() => { if (open) void refreshFonts(); }, [open]);

  const matches = useMemo(() => searchGoogleFonts(query, category), [query, category]);
  const remove = async family => {
    if (await removeFont(family)) onRemoved?.(family);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('fonts.picker.title')} size="lg" portal z={Z.alert}
      description={t('settings.text.googleFontsNote')}>
      <input type="search" value={query} onChange={e => setQuery(e.target.value)} aria-label={t('fonts.picker.search')}
        placeholder={t('fonts.picker.search')} autoFocus
        className="w-full h-9 px-3 text-sm rounded-lg border border-mail-border bg-mail-bg text-mail-text outline-none focus:border-mail-accent" />
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('fonts.picker.categories')}>
        {[null, ...GOOGLE_FONT_CATEGORIES].map(cat => (
          <Button key={cat || 'all'} variant={category === cat ? 'accentTint' : 'ghost'} size="xs" aria-pressed={category === cat}
            onClick={() => setCategory(cat)}>
            {cat ? t(CATEGORY_KEYS[cat]) : t('fonts.picker.all')}
          </Button>
        ))}
      </div>
      <ul className="max-h-80 overflow-y-auto -mx-2">
        {matches.slice(0, SHOWN).map(font => (
          <FontRow key={font.family} font={font} status={fontStatus(store, font.family)} onChoose={choose} onRemove={remove} />
        ))}
      </ul>
      {matches.length === 0 && <p className="text-sm text-mail-text-muted">{t('fonts.picker.noMatch')}</p>}
      {matches.length > SHOWN && <p className="text-xs text-mail-text-muted">{t('fonts.picker.narrow')}</p>}
    </Dialog>
  );
}
