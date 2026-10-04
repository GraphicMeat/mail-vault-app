import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader, ImagePlus, Minus, Plus, ExternalLink, PictureInPicture2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { useT } from '../../i18n/index.js';
import { useSettingsStore, DEFAULT_SOCIAL_EXPORT } from '../../stores/settingsStore';
import { buildSocialContent, buildSocialExport, chromeTheme } from '../../services/export/social/buildSocialExport';
import { composeSocialImage } from '../../services/export/social/composeSocialImage';
import { SIZE_PRESETS, MACOS_WINDOW_RADIUS, rangeMarkLeft, layoutSocial } from '../../services/export/social/socialLayout';
import { loadWatermark } from '../../services/export/social/socialWatermark';
import { GRADIENT_PRESETS, SOLID_PRESETS, DEFAULT_CUSTOM_STOPS, cssGradient } from '../../services/export/social/socialBackgrounds';
import { saveOneFile } from '../../services/export/exportSaver';
import { usePrivacyStore } from '../../stores/privacyStore';
import { useThemeStore } from '../../stores/themeStore';
import { useMailStore } from '../../stores/mailStore';
import { isSpamMessage } from '../../utils/spamFolder';

// The preview box before it is measured (and in the dialog, its height).
const PREVIEW_W = 360;
const PREVIEW_H = 420;
// Zoom is image pixels per screen pixel: 1 is the PNG's actual pixels.
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4];
// A step that moves visibly: from a fit of 32%, + goes to 50%, not 33%.
const nextZoom = (current, dir) => (dir > 0
  ? ZOOM_STEPS.find(z => z > current * 1.1) ?? ZOOM_STEPS.at(-1)
  : ZOOM_STEPS.findLast(z => z < current / 1.1) ?? ZOOM_STEPS[0]);
const dpr = () => (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
const SIZES = [
  { value: 'square', label: '1:1' },
  { value: 'portrait', label: '4:5' },
  { value: 'landscape', label: '16:9' },
  { value: 'story', label: '9:16' },
];
const RADIUS_MAX = 40;
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

// The full image's size in pixels, without composing it.
const fullSize = (content, prefs) => {
  const L = layoutSocial({ contentW: content.width, contentH: content.height, size: SIZE_PRESETS[prefs.size] ?? null, padding: prefs.padding, chrome: prefs.chrome });
  return { w: L.canvasW, h: L.canvasH };
};

// The preview box's inner size, followed as the dialog or the window resizes.
function useBoxSize(ref) {
  const [size, setSize] = useState({ w: PREVIEW_W, h: PREVIEW_H });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

// In the app the panel renders and saves here; a detached window hands both to its owner.
const localSource = (message) => ({
  buildContent: (options) => buildSocialContent(message, options),
  save: (options) => buildSocialExport({ message, options }),
});

const sameBackground = (a, b) => a?.type === b?.type && (a.type !== 'gradient' && a.type !== 'solid' ? true : a.id === b.id);

/**
 * The "Social" format of the export dialog: one message as a styled PNG,
 * either a card on a background or the app window with the message open.
 *
 * The content is rendered once per (content, redact, themes) and cached;
 * every style change re-composes from the cache. The style is remembered in
 * settings; redaction is on every time the panel opens (and cannot be turned
 * off while privacy mode is on), and an own image is never stored. Like the
 * app, there are two themes: Appearance (Light/Dark, the app's own theme until
 * one is picked) paints the window frame and, on a card, the header block, and
 * shoots the app window; Mail (card only) is the message body, following the
 * Appearance until one is picked.
 *
 * The preview zooms (Fit, actual pixels, steps between). `onPopOut` offers the
 * panel in a window of its own (SocialExportWindow), handing over the per-open
 * choices; there `detached` fills the window, `source` asks the main window to
 * render and `onPopIn` brings it back. `initial` carries those choices across.
 * `headerSlot` is an element at the top right of the dialog or the window that
 * the Open in window / Back to app button is portaled into (it reads the
 * panel's own choices and busy state); null while that element mounts, and
 * left out, the button sits in the footer.
 * ponytail: `account` and `mailbox` are accepted for parity with the other
 * formats but unused: a social card carries no export footer.
 */
export function SocialExportPanel({ message, onDone, source, detached = false, initial, onPrefsChange, onPopOut, onPopIn, headerSlot }) {
  const t = useT();
  const saved = useSettingsStore(s => s.socialExport);
  const setSocialExport = useSettingsStore(s => s.setSocialExport);
  const persistPrefs = onPrefsChange ?? setSocialExport;
  const src = useMemo(() => source ?? localSource(message), [source, message]);
  // Seeded once: the panel owns its style while open and writes through.
  const [prefs, setPrefs] = useState(() => ({ ...DEFAULT_SOCIAL_EXPORT, ...saved, ...initial?.prefs }));
  const [redact, setRedact] = useState(() => initial?.redact ?? true);
  // Per open, like redact: a spam message names its sender, anything else does not.
  const [revealSender, setRevealSender] = useState(() => initial?.revealSender ?? isSpamMessage(message, useMailStore.getState()));
  const [zoom, setZoom] = useState('fit');
  const boxRef = useRef(null);
  const box = useBoxSize(boxRef);
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

  // Appearance: the frame, the card's header block, the app window's shot.
  // Mail: the card's body, the Appearance's twin until picked (the reader's
  // `emailThemeOverride ?? theme`).
  const theme = prefs.appTheme ?? appTheme;
  const mailTheme = prefs.mailTheme ?? theme;
  const frameTheme = chromeTheme(prefs.content, theme);
  const isCard = prefs.content === 'card';
  const background = imageActive && ownImage ? ownImage : prefs.background;

  const update = (patch) => {
    setPrefs(p => ({ ...p, ...patch }));
    persistPrefs?.(patch);
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

  // The boxes (and the reveal) are part of the picture: a different choice is a different render.
  const reveal = redacting && revealSender;
  const details = prefs.senderDetails === true;
  const withLinks = isCard && prefs.links === true;

  useEffect(() => {
    const key = `${prefs.content}|${redacting}|${theme}|${isCard ? mailTheme : ''}|rv${reveal ? 1 : 0}|sd${details ? 1 : 0}|ln${withLinks ? 1 : 0}`;
    const id = ++request.current;
    const hit = cache.current.get(key);
    if (hit) { setContent(hit); setLoading(false); return; }
    // The old content goes now: an unredacted canvas must not stay painted
    // while the redacted one builds (privacy mode turned on mid-preview), nor
    // one that shows a sender after Show sender was turned off.
    setContent(null);
    setLoading(true);
    setNotice(null);
    src.buildContent({
      content: prefs.content, redact: redacting, theme,
      ...(isCard ? { mailTheme } : {}),
      ...(reveal ? { revealSender: true } : {}),
      ...(details ? { senderDetails: true } : {}),
      ...(withLinks ? { links: true } : {}),
    })
      .then((canvas) => {
        cache.current.set(key, canvas);
        if (request.current === id) setContent(canvas);
      })
      .catch((err) => {
        if (request.current !== id) return;
        setContent(null);
        setNotice(err?.code === 'not-open' ? t('export.social.openInApp') : t('export.dialog.messageCouldExported'));
      })
      .finally(() => { if (request.current === id) setLoading(false); });
  }, [src, prefs.content, redacting, theme, mailTheme, reveal, details, withLinks]);

  // Fit never enlarges past actual pixels: a small image would only blur.
  const full = content ? fullSize(content, prefs) : null;
  const fitZoom = full ? Math.min(1, (box.w / full.w) * dpr(), (box.h / full.h) * dpr()) : 1;
  const zoomLevel = zoom === 'fit' ? fitZoom : zoom;

  // The preview composes at the size it is shown (screen pixels), never the
  // full image unless zoomed to it: a 2160x3840 story per slider step is waste.
  useEffect(() => {
    if (!content || !full) return;
    const ratio = dpr();
    // Down, not to nearest: a fitted canvas 1px over the box shows a scrollbar,
    // which shrinks the box, which re-fits, which hides it again.
    const cssW = Math.max(1, Math.floor((full.w * zoomLevel) / ratio + 1e-6));
    const cssH = Math.max(1, Math.floor((full.h * zoomLevel) / ratio + 1e-6));
    const out = composeSocialImage({
      content, size: SIZE_PRESETS[prefs.size] ?? null, background,
      padding: prefs.padding, radius: prefs.radius, shadow: prefs.shadow, chrome: prefs.chrome,
      theme: frameTheme, maxSize: { w: cssW * ratio, h: cssH * ratio }, watermark,
    });
    const canvas = previewRef.current;
    if (!canvas || !out.width || !out.height) return;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = out.width;
    canvas.height = out.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(out, 0, 0, canvas.width, canvas.height);
  }, [content, full?.w, full?.h, zoomLevel, prefs.size, prefs.padding, prefs.radius, prefs.shadow, prefs.chrome, prefs.content, background, frameTheme, watermark]);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await src.save({ ...prefs, background, redact: redacting, appTheme: theme, mailTheme, revealSender: reveal }, content);
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
  const themeOptions = useMemo(() => [{ value: 'light', label: t('settings.colors.light') }, { value: 'dark', label: t('settings.colors.dark') }], [t]);
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

  const zoomButton = 'h-7 min-w-7 px-1.5 rounded-md border border-mail-border text-xs text-mail-text-muted hover:text-mail-text hover:border-mail-accent/50 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed';
  const preview = (
    <div className={`flex flex-col gap-2 min-w-0 ${detached ? 'flex-1 min-h-0' : ''}`}>
      {/* margin:auto, not flex centering: a centered box clips the top and left of a zoomed preview. */}
      <div ref={boxRef} className={`flex overflow-auto rounded-xl bg-mail-bg border border-mail-border p-2
        ${detached ? 'flex-1 min-h-0' : 'h-[436px]'}`}>
        {loading && !content ? <Loader size={18} className="m-auto animate-spin text-mail-text-muted" /> : (
          <canvas ref={previewRef} role="img" aria-label={t('export.social.preview')}
            className="m-auto shrink-0 rounded-md" style={background.type === 'transparent' ? { background: CHECKERBOARD } : undefined} />
        )}
      </div>
      <div role="group" aria-label={t('export.social.zoom')} className="flex items-center gap-1.5">
        <button type="button" className={zoomButton} aria-label={t('export.social.zoomOut')} title={t('export.social.zoomOut')}
          disabled={!content || zoomLevel <= ZOOM_STEPS[0] + 0.001} onClick={() => setZoom(nextZoom(zoomLevel, -1))}>
          <Minus size={14} aria-hidden="true" />
        </button>
        <span className="w-11 text-center text-xs tabular-nums text-mail-text-muted" role="status">{Math.round(zoomLevel * 100)}%</span>
        <button type="button" className={zoomButton} aria-label={t('export.social.zoomIn')} title={t('export.social.zoomIn')}
          disabled={!content || zoomLevel >= ZOOM_STEPS.at(-1) - 0.001} onClick={() => setZoom(nextZoom(zoomLevel, 1))}>
          <Plus size={14} aria-hidden="true" />
        </button>
        <button type="button" className={zoomButton} aria-pressed={zoom === 'fit'} disabled={!content} onClick={() => setZoom('fit')}>
          {t('export.social.zoomFit')}
        </button>
        <button type="button" className={zoomButton} aria-pressed={zoom === 1} aria-label={t('export.social.zoomActualAria')}
          disabled={!content} onClick={() => setZoom(1)}>
          {t('export.social.zoomActual')}
        </button>
      </div>
    </div>
  );

  const handOff = onPopOut ?? onPopIn;
  const windowButton = handOff && (
    <Button variant="ghost" size="sm" className={headerSlot ? '' : 'mr-auto'} disabled={busy}
      onClick={() => handOff({ redact, revealSender, prefs })}>
      {onPopOut ? <ExternalLink size={14} aria-hidden="true" /> : <PictureInPicture2 size={14} aria-hidden="true" />}
      {onPopOut ? t('export.social.popOut') : t('export.social.popIn')}
    </Button>
  );

  return (
    <>
      {headerSlot && windowButton && createPortal(windowButton, headerSlot)}
      <div className={detached
        ? 'flex-1 min-h-0 flex gap-5'
        : 'grid grid-cols-1 sm:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-5'}>
        {preview}

        <div className={`space-y-3 min-w-0 ${detached ? 'w-80 shrink-0 overflow-y-auto pr-1' : ''}`}>
          <Field label={t('export.social.content')}>
            <Chips label={t('export.social.content')} value={prefs.content} onChange={v => update({ content: v })}
              options={[{ value: 'card', label: t('export.social.contentCard') }, { value: 'app', label: t('export.social.contentApp') }]} />
          </Field>

          <Field label={t('export.social.appearance')}>
            <Chips label={t('export.social.appearance')} value={theme} onChange={v => update({ appTheme: v })} options={themeOptions} />
          </Field>

          {isCard && (
            <Field label={t('export.social.mailAppearance')}>
              <Chips label={t('export.social.mailAppearance')} value={mailTheme} onChange={v => update({ mailTheme: v })} options={themeOptions} />
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

          <div className="space-y-1">
            <span className="flex justify-between text-xs font-medium text-mail-text-muted">
              <span>{t('export.social.radius')}</span><span>{prefs.radius}</span>
            </span>
            <input type="range" min="0" max={RADIUS_MAX} step="1" value={prefs.radius} className="w-full"
              aria-label={t('export.social.radius')} onChange={e => update({ radius: Number(e.target.value) })} />
            {/* Our own mark: WKWebView draws no <datalist> ticks. */}
            <div className="relative h-6">
              <button type="button" aria-label={t('export.social.radiusMacosAria')} onClick={() => update({ radius: MACOS_WINDOW_RADIUS })}
                style={{ left: rangeMarkLeft(MACOS_WINDOW_RADIUS, 0, RADIUS_MAX) }}
                className="absolute top-0 -translate-x-1/2 flex flex-col items-center text-[10px] leading-tight text-mail-text-muted hover:text-mail-text">
                <span aria-hidden="true" className="block w-px h-1.5 bg-mail-text-muted" />
                <span aria-hidden="true">{t('export.social.radiusMacos')}</span>
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('export.social.shadow')}</span>
            <ToggleSwitch active={prefs.shadow} label={t('export.social.shadow')} onClick={() => update({ shadow: !prefs.shadow })} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('export.social.chrome')}</span>
            <ToggleSwitch active={prefs.chrome} label={t('export.social.chrome')} onClick={() => update({ chrome: !prefs.chrome })} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-mail-text">{t('export.social.senderDetails')}</span>
            <ToggleSwitch active={details} label={t('export.social.senderDetails')} onClick={() => update({ senderDetails: !details })} />
          </div>
          {/* The reader already marks a risky link in the body, so the app window has no list. */}
          {isCard && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-mail-text">{t('export.social.links')}</span>
              <ToggleSwitch active={withLinks} label={t('export.social.links')} onClick={() => update({ links: !withLinks })} />
            </div>
          )}

          <label className={`flex items-start gap-2 ${privacyOn ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
            <input type="checkbox" checked={redacting} disabled={privacyOn} onChange={e => setRedact(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="block text-sm text-mail-text">{t('export.dialog.redactLabel')}</span>
              {privacyOn && <span className="block text-xs text-mail-text-muted">{t('export.social.redactForced')}</span>}
            </span>
          </label>

          {redacting && (
            <div className="flex items-start justify-between gap-3">
              <span>
                <span className="block text-sm text-mail-text">{t('export.social.revealSender')}</span>
                <span className="block text-xs text-mail-text-muted">{t('export.social.revealSenderHint')}</span>
              </span>
              <ToggleSwitch active={revealSender} label={t('export.social.revealSender')} onClick={() => setRevealSender(v => !v)} />
            </div>
          )}
        </div>
      </div>

      {notice && <p className="text-xs text-mail-danger">{notice}</p>}

      <div className="flex items-center justify-end gap-2">
        {headerSlot === undefined && windowButton}
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>{detached ? t('common.close') : t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={save} disabled={busy || loading || !content}>
          {busy && <Loader size={14} className="animate-spin" />}{t('export.social.save')}
        </Button>
      </div>
    </>
  );
}
