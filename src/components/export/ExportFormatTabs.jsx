import React from 'react';
import { ImageDown, FileCode2, Share2 } from 'lucide-react';
import { useT } from '../../i18n/index.js';

// One tab strip for the three formats, the dialog's and the window's. Native
// radios under it, so the arrow keys and the group come free; each input keeps
// the bare format as its accessible name ("Image", not its hint), as Choice does.
export function ExportFormatTabs({ value, onChange, socialDisabled = false }) {
  const t = useT();
  const tabs = [
    { value: 'image', icon: ImageDown, label: t('export.dialog.formatImageLabel'), hint: t('export.dialog.formatImageHint') },
    { value: 'html', icon: FileCode2, label: t('export.dialog.formatHtmlLabel'), hint: t('export.dialog.formatHtmlHint') },
    {
      value: 'social', icon: Share2, label: t('export.social.formatLabel'), disabled: socialDisabled,
      hint: socialDisabled ? t('export.social.singleOnly') : t('export.social.formatHint'),
    },
  ];
  return (
    <div role="radiogroup" aria-label={t('common.export')}
      className="inline-flex self-start gap-1 p-1 rounded-lg border border-mail-border bg-mail-bg">
      {tabs.map(({ value: format, icon: Icon, label, hint, disabled }) => {
        const checked = value === format;
        return (
          <label key={format} title={hint}
            className={disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}>
            <input type="radio" name="mv-export-format" value={format} checked={checked} disabled={disabled}
              aria-label={label} onChange={() => onChange(format)} className="peer sr-only" />
            <span className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors
              peer-focus-visible:ring-2 peer-focus-visible:ring-mail-accent
              ${checked ? 'bg-mail-accent-tint text-mail-text shadow-sm' : disabled ? 'text-mail-text-muted' : 'text-mail-text-muted hover:text-mail-text'}`}>
              <Icon size={14} aria-hidden="true" />{label}
            </span>
          </label>
        );
      })}
    </div>
  );
}
