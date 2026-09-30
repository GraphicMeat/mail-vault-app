import React, { useEffect, useRef, useState } from 'react';
import { RichTextEditor } from '../RichTextEditor';
import { SegmentedControl } from '../ui/SettingsForm';
import { initialSignatureSource, signatureSourceReducer } from '../../utils/signatureSource';
import { useT } from '../../i18n/index.js';

/**
 * A signature's editor, with a Rendered / Code switch. Code shows the HTML as
 * text; what is typed there is read back through the editor's own schema
 * (utils/signatureSource.js) before `onChange` hears of it, so the saved
 * signature is the same sanitized HTML either view produces.
 */
export function SignatureEditor({ html, onChange, placeholder, heightClass = 'h-52', boxTestId }) {
  const t = useT();
  const [state, setState] = useState(() => initialSignatureSource(html));
  // What this editor last reported: a different `html` came from outside
  // (another account opened), and a draft of the old signature is no use.
  const reported = useRef(html);

  const apply = (action) => {
    const next = signatureSourceReducer(state, action);
    setState(next);
    if (next.html !== state.html) { reported.current = next.html; onChange(next.html); }
  };

  useEffect(() => {
    if (html === reported.current) return;
    reported.current = html;
    setState(signatureSourceReducer(state, { type: 'external', html }));
  }, [html]);

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SegmentedControl
          label={t('settings.accounts.signatureView')}
          value={state.mode}
          options={[
            { value: 'rendered', label: t('settings.accounts.signatureViewRendered') },
            { value: 'code', label: t('settings.accounts.signatureViewCode') },
          ]}
          onChange={mode => apply({ type: 'mode', mode })}
        />
      </div>
      <div className={`flex ${heightClass} rounded-lg border border-mail-border overflow-hidden`} data-testid={boxTestId}>
        {state.mode === 'code' ? (
          <textarea
            data-testid="signature-source"
            value={state.draft}
            onChange={e => apply({ type: 'draft', draft: e.target.value })}
            aria-label={t('settings.accounts.signatureSourceLabel')}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            dir="ltr"
            className="flex-1 w-full h-full resize-none p-4 font-mono text-xs bg-mail-bg text-mail-text focus:outline-none"
          />
        ) : (
          <RichTextEditor
            imageTools
            content={state.html}
            onUpdate={next => apply({ type: 'html', html: next })}
            placeholder={placeholder}
          />
        )}
      </div>
      {state.mode === 'code' && (
        <p className="text-xs text-mail-text-muted mt-2">{t('settings.accounts.signatureSourceHint')}</p>
      )}
    </div>
  );
}
