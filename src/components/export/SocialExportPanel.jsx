import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader, ImagePlus } from 'lucide-react';
import { Button } from '../ui/Button';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { useT } from '../../i18n/index.js';
import { useSettingsStore, DEFAULT_SOCIAL_EXPORT } from '../../stores/settingsStore';
import { buildSocialContent, buildSocialExport, chromeTheme } from '../../services/export/social/buildSocialExport';
import { composeSocialImage } from '../../services/export/social/composeSocialImage';
import { SIZE_PRESETS } from '../../services/export/social/socialLayout';
import { loadWatermark } from '../../services/export/social/socialWatermark';
import { GRADIENT_PRESETS, SOLID_PRESETS, DEFAULT_CUSTOM_STOPS, cssGradient } from '../../services/export/social/socialBackgrounds';
import { saveOneFile } from '../../services/export/exportSaver';
import { usePrivacyStore } from '../../stores/privacyStore';
import { useThemeStore } from '../../stores/themeStore';

const PREVIEW_W = 360;
const PREVIEW_H = 420;
// The preview composes at its own size (2x for a sharp canvas), not the
// full-size image: a 2160x3840 story per slider step is wasted work.
const PREVIEW_MAX = { w: PREVIEW_W * 2, h: PREVIEW_H * 2 };
const SIZES = [
  { value: 'square', label: '1:1' },
  { value: 'portrait', label: '4:5' },
  { value: 'landscape', label: '16:9' },
  { value: 'story', label: '9:16' },
];
const CHECKERBOARD = 'repeating-conic-gradient(#d4d4d8 0% 25%, #ffffff 0% 50%) 50% / 12px 12px';

// A compact one-of-a-few row: the settings SegmentedChoice is a 48px tab row.
function Chips({ label, options, value, onChange }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={value === o.value} disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 rounded-md border text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed
            ${value === o.value ? 'border-mail-accent bg-mail-accent-tint text-mail-text' : 'border-mail-border text-mail-text-muted hover:border-mail-accent/50'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Swatch({ label, selected, style, onClick, children }) {
  return (
    <button type="button" aria-label={label} aria-pressed={selected} onClick={onClick} style={style}
      className={`h-7 w-7 rounded-md border flex items-center justify-center
        ${selected ? 'ring-2 ring-mail-accent ring-offset-1 ring-offset-mail-surface border-transparent' : 'border-mail-border'}`}>
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-mail-text-muted">{label}</span>
      {children}
    </div>
  );
}

const sameBackground = (a, b) => a?.type === b?.type && (a.type !== 'gradient' && a.type !== 'solid' ? true : a.id === b.id);

/**
 * The "Social" format of the export dialog: one message as a styled PNG,
 * either a card on a background or the app window with the message open.
 *
 * The content is rendered once per (content, redact, app theme) and cached;
 * every style change re-composes from the cache. The style is remembered in
 * settings; redaction is on every time the panel opens (and cannot be turned
 * off while privacy mode is on), and an own image is never stored. The card is
 * light; the app window is shot in the chosen Light/Dark (the app's own theme
 * until one is picked) and its frame follows that.
 * ponytail: `account` and `mailbox` are accepted for parity with the other
 * formats but unused: a social card carries no export footer.
 */
export function SocialExportPanel({ message, onDone }) {
  const t = useT();
  const saved = useSettingsStore(s => s.socialExport);
  const setSocialExport = useSettingsStore(s => s.setSocialExport);
  // Seeded once: the panel owns its style while open and writes through.
  const [prefs, setPrefs] = useState(() => ({ ...DEFAULT_SOCIAL_EXPORT, ...saved }));
  const [redact, setRedact] = useState(true);
  // Privacy mode on: a social image never shows anyone, whatever the checkbox said.
  const privacyOn = usePrivacyStore(s => s.enabled);
  const redacting = redact || privacyOn;
  const appTheme = useThemeStore(s => s.theme);
  const [ownImage, setOwnImage] = useState(null); // { type: 'image', image }, in memory only
  const [imageActive, setImageActive] = useState(false);
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [watermark, setWatermark] = useState(null);
  const previewRef = useRef(null);
  const request = useRef(0);
  const cache = useRef(new Map());

  // The app window is shot in this theme, and its frame follows it.
  const theme = prefs.appTheme ?? appTheme;
  const frameTheme = chromeTheme(prefs.content, theme);
  const background = imageActive && ownImage ? ownImage : prefs.background;

  const update = (patch) => {
    setPrefs(p => ({ ...p, ...patch }));
    setSocialExport?.(patch);
  };
  const pickBackground = (bg) => { setImageActive(false); update({ background: bg }); };

  // An own image is a decoded bitmap: the app's CSP admits no blob: URLs.
  useEffect(() => () => ownImage?.image?.close?.(), [ownImage]);
  const pickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const image = await createImageBitmap(file);
      setOwnImage({ type: 'image', image });
      setImageActive(true);
    } catch {
      setNotice(t('export.dialog.messageCouldExported'));
    }
  };

  useEffect(() => { cache.current = new Map(); }, [message]);

  // The preview carries the mark Save puts on, once it has decoded.
  useEffect(() => {
    let live = true;
    loadWatermark().then((mark) => { if (live) setWatermark(mark); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const key = `${prefs.content}|${redacting}|${prefs.content === 'app' ? theme : ''}`;
    const id = ++request.current;
    const hit = cache.current.get(key);
    if (hit) { setContent(hit); setLoading(false); return; }
    // The old content goes now: an unredacted canvas must not stay painted
    // while the redacted one builds (privacy mode turned on mid-preview).
    setContent(null);
    setLoading(true);
    setNotice(null);
    buildSocialContent(message, { content: prefs.content, redact: redacting, theme })
      .then((canvas) => {
        cache.current.set(key, canvas);
        if (request.current === id) setContent(canvas);
      })
      .catch(() => { if (request.current === id) { setContent(null); setNotice(t('export.dialog.messageCouldExported')); } })
      .finally(() => { if (request.current === id) setLoading(false); });
  }, [message, prefs.content, redacting, theme]);

  useEffect(() => {
    if (!content) return;
    const out = composeSocialImage({
      content, size: SIZE_PRESETS[prefs.size] ?? null, background,
      padding: prefs.padding, radius: prefs.radius, shadow: prefs.shadow, chrome: prefs.chrome,
      theme: frameTheme, fit: prefs.content === 'app' ? 'contain' : 'crop', maxSize: PREVIEW_MAX, watermark,
    });
    const canvas = previewRef.current;
    if (!canvas || !out.width || !out.height) return;
    const scale = Math.min(PREVIEW_W / out.width, PREVIEW_H / out.height);
    const w = Math.max(1, Math.round(out.width * scale));
    const h = Math.max(1, Math.round(out.height * scale));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(out, 0, 0, canvas.width, canvas.height);
  }, [content, prefs.size, prefs.padding, prefs.radius, prefs.shadow, prefs.chrome, prefs.content, background, frameTheme, watermark]);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await buildSocialExport({ message, options: { ...prefs, background, redact: redacting, appTheme: theme } });
      if (!result.ok) {
        setNotice(result.reason === 'premium' ? t('export.dialog.exportPremiumFeature') : t('export.dialog.messageCouldExported'));
        return;
      }
      const written = await saveOneFile(result.file, t('common.export'));
      if (written) onDone?.();
    } catch (err) {
      setNotice(t('export.dialog.exportFailed', { err: err.message || err }));
    } finally {
      setBusy(false);
    }
  };

  const customStops = prefs.background.type === 'custom' && prefs.background.stops?.length >= 2
    ? prefs.background.stops : DEFAULT_CUSTOM_STOPS;
  const sizeOptions = useMemo(() => [{ value: 'auto', label: t('export.social.sizeAuto') }, ...SIZES], [t]);
  // A swatch's accessible name. Literal keys, so the catalog check sees each.
  const names = useMemo(() => ({
    sunset: t('export.social.swatch.sunset'), ocean: t('export.social.swatch.ocean'),
    aurora: t('export.social.swatch.aurora'), candy: t('export.social.swatch.candy'),
    lime: t('export.social.swatch.lime'), peach: t('export.social.swatch.peach'),
    violet: t('export.social.swatch.violet'), ember: t('export.social.swatch.ember'),
    mint: t('export.social.swatch.mint'), midnight: t('export.social.swatch.midnight'),
    white: t('export.social.swatch.white'), black: t('export.social.swatch.black'),
    graphite: t('export.social.swatch.graphite'), cream: t('export.social.swatch.cream'),
    sky: t('export.social.swatch.sky'), blush: t('export.social.swatch.blush'),
  }), [t]);

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-5">
        <div className="flex items-center justify-center min-h-[200px] rounded-xl bg-mail-bg border border-mail-border p-2">
          {loading && !content ? <Loader size={18} className="animate-spin text-mail-text-muted" /> : (
            <canvas ref={previewRef} role="img" aria-label={t('export.social.preview')}
              className="max-w-full rounded-md" style={background.type === 'transparent' ? { background: CHECKERBOARD } : undefined} />
          )}
        </div>

        <div className="space-y-3 min-w-0">
          <Field label={t('export.social.content')}>
            <Chips label={t('export.social.content')} value={prefs.content} onChange={v => update({ content: v })}
              options={[{ value: 'card', label: t('export.social.contentCard') }, { value: 'app', label: t('export.social.contentApp') }]} />
          </Field>

          {prefs.content === 'app' && (
            <Field label={t('export.social.appearance')}>
              <Chips label={t('export.social.appearance')} value={theme} onChange={v => update({ appTheme: v })}
                options={[{ value: 'light', label: t('settings.colors.light') }, { value: 'dark', label: t('settings.colors.dark') }]} />
            </Field>
          )}

          <Field label={t('export.social.size')}>
            <Chips label={t('export.social.size')} value={prefs.size} onChange={v => update({ size: v })} options={sizeOptions} />
          </Field>

          <Field label={t('export.social.background')}>
            <div className="flex flex-wrap gap-1.5">
              {GRADIENT_PRESETS.map(g => (
                <Swatch key={g.id} label={names[g.id]} style={{ background: cssGradient(g.stops, g.angle) }}
                  selected={!imageActive && sameBackground(prefs.background, { type: 'gradient', id: g.id })}
                  onClick={() => pickBackground({ type: 'gradient', id: g.id })} />
              ))}
              {SOLID_PRESETS.map(s => (
                <Swatch key={s.id} label={names[s.id]} style={{ background: s.color }}
                  selected={!imageActive && sameBackground(prefs.background, { type: 'solid', id: s.id })}
                  onClick={() => pickBackground({ type: 'solid', id: s.id })} />
              ))}
              <Swatch label={t('export.social.custom')} style={{ background: cssGradient(customStops, 45) }}
                selected={!imageActive && prefs.background.type === 'custom'}
                onClick={() => pickBackground({ type: 'custom', stops: customStops })} />
              <Swatch label={t('export.social.transparent')} style={{ background: CHECKERBOARD }}
                selected={!imageActive && prefs.background.type === 'transparent'}
                onClick={() => pickBackground({ type: 'transparent' })} />
              <label title={t('export.social.image')}
                className={`h-7 w-7 rounded-md border flex items-center justify-center cursor-pointer text-mail-text-muted hover:text-mail-text
                  ${imageActive ? 'ring-2 ring-mail-accent ring-offset-1 ring-offset-mail-surface border-transparent' : 'border-mail-border'}`}>
                <ImagePlus size={14} aria-hidden="true" />
                <input type="file" accept="image/*" className="sr-only" aria-label={t('export.social.image')} onChange={pickImage} />
              </label>
            </div>
            {!imageActive && prefs.background.type === 'custom' && (
              <div className="flex items-center gap-2 pt-1">
                <input type="color" aria-label={t('export.social.customFrom')} value={customStops[0]}
                  onChange={e => update({ background: { type: 'custom', stops: [e.target.value, customStops[1]] } })} />
                <input type="color" aria-label={t('export.social.customTo')} value={customStops[1]}
                  onChange={e => update({ background: { type: 'custom', stops: [customStops[0], e.target.value] } })} />
              </div>
            )}
          </Field>

          <label className="block space-y-1">
            <span className="flex justify-between text-xs font-medium text-mail-text-muted">
              <span>{t('export.social.padding')}</span><span>{prefs.padding}</span>
            </span>
            <input type="range" min="0" max="160" step="4" value={prefs.padding} className="w-full"
              aria-label={t('export.social.padding')} onChange={e => update({ padding: Number(e.target.value) })} />
          </label>

          <label className="block space-y-1">
            <span className="flex justify-between text-xs font-medium text-mail-text-muted">
              <span>{t('export.social.radius')}</span><span>{prefs.radius}</span>
            </span>
            <input type="range" min="0" max="40" step="1" value={prefs.radius} className="w-full"
              aria-label={t('export.social.radius')} onChange={e => update({ radius: Number(e.target.value) })} />
          </label>

          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('export.social.shadow')}</span>
            <ToggleSwitch active={prefs.shadow} label={t('export.social.shadow')} onClick={() => update({ shadow: !prefs.shadow })} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('export.social.chrome')}</span>
            <ToggleSwitch active={prefs.chrome} label={t('export.social.chrome')} onClick={() => update({ chrome: !prefs.chrome })} />
          </div>

          <label className={`flex items-start gap-2 ${privacyOn ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
            <input type="checkbox" checked={redacting} disabled={privacyOn} onChange={e => setRedact(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="block text-sm text-mail-text">{t('export.dialog.redactLabel')}</span>
              {privacyOn && <span className="block text-xs text-mail-text-muted">{t('export.social.redactForced')}</span>}
            </span>
          </label>
        </div>
      </div>

      {notice && <p className="text-xs text-mail-danger">{notice}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={save} disabled={busy || loading || !content}>
          {busy && <Loader size={14} className="animate-spin" />}{t('export.social.save')}
        </Button>
      </div>
    </>
  );
}
