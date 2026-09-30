import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Type } from 'lucide-react';
import { RichTextEditor } from '../RichTextEditor';
import { SegmentedControl } from '../ui/SettingsForm';
import { Popover, MenuItem } from '../ui/Popover';
import { FIELD_TRIGGER, anchorTo } from '../ui/field';
import { GoogleFontPicker } from './GoogleFontPicker';
import { initialSignatureSource, setSignatureFont, signatureSourceReducer } from '../../utils/signatureSource';
import { SIGNATURE_FONTS, signatureFontStack } from '../../utils/signatureFonts';
import { refreshFonts, useFontStore } from '../../services/fontService';
import { useT } from '../../i18n/index.js';

// The family a signature is first written in, for the control to show.
const firstFamily = html => (/font-family:\s*(?:&quot;|["'])?([^,;"'&]+)/.exec(html || '')?.[1] || '').trim();

const MENU_GROUPS = [
  ['webSafe', 'settings.accounts.signatureFontsCommon'],
  ['bundled', 'settings.accounts.signatureFontsApp'],
];

/**
 * The signature's font: common faces most mail clients have, the app's own,
 * downloaded Google Fonts, and "More fonts…" for the picker. `onChoose` gets
 * the family list to write ('' for the default). Recipients who lack the
 * face see its fallback; the hint under the editor says so.
 */
function SignatureFontControl({ html, disabled, onChoose }) {
  const t = useT();
  const trigger = useRef(null);
  const [menu, setMenu] = useState(null);
  const [picking, setPicking] = useState(false);
  const installed = useFontStore(s => s.installed);
  useEffect(() => { void refreshFonts(); }, []);
  const current = firstFamily(html);
  const choose = family => { setMenu(null); onChoose(family ? signatureFontStack(family) : ''); };
  const item = family => (
    <MenuItem key={family} onClick={() => choose(family)} style={{ fontFamily: signatureFontStack(family) }}>{family}</MenuItem>
  );
  const heading = key => <p className="px-3 pt-2 pb-1 text-xs font-medium text-mail-text-muted" role="presentation">{t(key)}</p>;
  return (
    <>
      <button ref={trigger} type="button" className={FIELD_TRIGGER} disabled={disabled} aria-haspopup="menu" aria-expanded={!!menu}
        onClick={() => setMenu(anchorTo(trigger.current, 320))}>
        <Type size={14} aria-hidden="true" />
        <span className="sr-only">{t('settings.accounts.signatureFont')}</span>
        <span style={{ fontFamily: current ? signatureFontStack(current) || undefined : undefined }}>{current || t('settings.accounts.signatureFontDefault')}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <Popover open={!!menu} onClose={() => setMenu(null)} style={menu || undefined} role="menu" className="max-h-80 overflow-y-auto">
        <MenuItem onClick={() => choose('')}>{t('settings.accounts.signatureFontDefault')}</MenuItem>
        {MENU_GROUPS.map(([kind, key]) => (
          <React.Fragment key={kind}>
            {heading(key)}
            {SIGNATURE_FONTS.filter(font => font.kind === kind).map(font => item(font.family))}
          </React.Fragment>
        ))}
        {installed.length > 0 && heading('settings.text.downloadedFonts')}
        {installed.map(item)}
        <MenuItem onClick={() => { setMenu(null); setPicking(true); }}>{t('settings.accounts.signatureFontMore')}</MenuItem>
      </Popover>
      <GoogleFontPicker open={picking} onClose={() => setPicking(false)}
        onPick={family => { setPicking(false); onChoose(signatureFontStack(family)); }} />
    </>
  );
}

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
  const editor = useRef(null);

  const apply = (action) => {
    const next = signatureSourceReducer(state, action);
    setState(next);
    if (next.html !== state.html) { reported.current = next.html; onChange(next.html); }
  };

  // With the live editor: the selection, or everything when nothing is
  // selected, in the editor's own history. Otherwise the whole signature.
  const setFont = (stack) => {
    const live = state.mode === 'rendered' ? editor.current : null;
    if (live && !live.isDestroyed) {
      const chain = live.chain().focus();
      if (live.state.selection.empty) chain.selectAll();
      (stack ? chain.setFontFamily(stack) : chain.unsetFontFamily()).run();
      return;
    }
    apply({ type: 'html', html: setSignatureFont(state.html, stack) });
  };

  useEffect(() => {
    if (html === reported.current) return;
    reported.current = html;
    setState(signatureSourceReducer(state, { type: 'external', html }));
  }, [html]);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <SignatureFontControl html={state.html} disabled={state.mode === 'code'} onChoose={setFont} />
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
            editorRef={editor}
            imageTools
            content={state.html}
            onUpdate={next => apply({ type: 'html', html: next })}
            placeholder={placeholder}
          />
        )}
      </div>
      <p className="text-xs text-mail-text-muted mt-2">
        {state.mode === 'code' ? t('settings.accounts.signatureSourceHint') : t('settings.accounts.signatureFontHint')}
      </p>
    </div>
  );
}
