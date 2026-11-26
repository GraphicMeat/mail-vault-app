// Settings > Appearance on the phone: desktop's Appearance views (src/components/settings/views)
// over the phone's preferences (`mobile.prefs.*` through the store's setPrefs; the engine's
// `settings.rs` PREFS). Each section is the desktop's, less the rows a phone has no use for
// (settingsManifest.js MOBILE_SETTINGS names them and why):
//
// - Colors: theme (with System, which the phone defaults to), palette, the home screen icon
//   (`mobile_app_icon` first, then `appIcon`, so a refused switch keeps the old one), and the
//   email viewer's theme.
// - Text: text size and font (prefs.js applyLook). Every font ships with the app; the phone
//   downloads none, so desktop's "More fonts" is not here.
// - Layout: mail view (with desktop's sample conversation for the chat view), folder icons
//   (colourful or theme; `folderIconStyle`), list density and
//   preview lines (rowHeight, MessageRow.jsx), the pair sharing one sample drawn with the list's
//   own row face (MessageRow.jsx RowFace) over sample messages, at the chosen text size.
// - Reading: conversations, their order, signatures and the viewer toolbar's buttons.
// - Date & time: date and time formats; a custom pattern is written as typing pauses.
// - Quick actions: desktop's presets, action list and add row for the viewer's bar
//   (QuickActions.jsx).
// - Language: the nine languages (`mobile.settings.set` `language`, loaded at once) and the
//   translation issue report, opened in the system browser.
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import purple from '../../assets/mailvault-icon.png';
import teal from '../../assets/mailvault-icon-teal.png';
import { AppearanceView, validAppearanceSection } from '../../components/settings/views/AppearanceView';
import { ColorSchemeView } from '../../components/settings/views/ColorSchemeView';
import { AppIconView } from '../../components/settings/views/AppIconView';
import { TextSettingsView } from '../../components/settings/views/TextSettingsView';
import { WorkspaceView } from '../../components/settings/views/WorkspaceView';
import { FIRST_REPLY, SAMPLE_DATE, SampleConversationView } from '../../components/settings/views/PreviewViews';
import { DateTimeView, ReadingView } from '../../components/settings/views/ReadingDateViews';
import { LanguageView, TranslationIssueReportView } from '../../components/settings/views/LanguageView';
import { getEmailColors } from '../../utils/mailChrome';
import { translationReportUrl } from '../../utils/translationReport.js';
import { useMobileStore } from '../store.js';
import { getMobileLocale, loadMobileLocale, useT } from '../i18n.js';
import { daemonCall, setAppIcon } from '../transport.js';
import { normalizeAppIcon } from '../appIcon.js';
import { APP_FONTS, PALETTES, TEXT_SCALES, THEMES, fontStack, rowHeight, viewerTheme } from '../prefs.js';
import { RowFace } from '../MessageRow.jsx';
import QuickActions from './QuickActions.jsx';
import { MobileViewEnv, SaveFailed, useSavePrefs, openExternal } from './MobileViewEnv.jsx';

const APP_VERSION = import.meta.env?.MV_APP_VERSION || '';
const ICONS = { purple, teal };
const LIGHT_QUERY = '(prefers-color-scheme: light)';

function subscribeSystem(onChange) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(LIGHT_QUERY);
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}
const systemLight = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(LIGHT_QUERY).matches;

/** Whether the system shows light now, following it live. */
function useSystemLight() {
  return useSyncExternalStore(subscribeSystem, systemLight, () => false);
}

function ColorScheme({ save }) {
  const prefs = useMobileStore((s) => s.prefs);
  const light = useSystemLight();
  const effectiveTheme = viewerTheme(light, prefs);
  const palette = PALETTES.includes(prefs.palette) ? prefs.palette : 'indigo';
  return (
    <ColorSchemeView themes={THEMES} theme={prefs.theme} systemTheme={light ? 'light' : 'dark'} onTheme={(theme) => save({ theme })}
      palettes={PALETTES} palette={palette} onPalette={(next) => save({ palette: next })}
      appIcon={<AppIcon />}
      emailViewerTheme={prefs.emailViewerTheme} onEmailViewerTheme={(emailViewerTheme) => save({ emailViewerTheme })}
      emailPreview={{ effectiveTheme, colors: getEmailColors(effectiveTheme, palette) }} />
  );
}

/** The home screen icon: the shell switches it first, then `appIcon` is stored. */
function AppIcon() {
  const selected = useMobileStore((s) => normalizeAppIcon(s.prefs.appIcon));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const choose = async (icon) => {
    if (pending || icon === selected) return;
    setPending(true);
    setError(false);
    try {
      await setAppIcon(icon);
      if (!(await useMobileStore.getState().setPrefs({ appIcon: icon }))) setError(true);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };
  return <AppIconView icons={ICONS} selected={selected} pending={pending} error={error} onChoose={choose} />;
}

function Text({ save }) {
  const prefs = useMobileStore((s) => s.prefs);
  return (
    <TextSettingsView textScale={prefs.textScale} onTextScale={(textScale) => save({ textScale })} scales={TEXT_SCALES}
      fontOptions={{ fonts: APP_FONTS, fontStack, value: prefs.appFont, onChange: (appFont) => save({ appFont }) }} />
  );
}

/** The layout rows a phone has: the mail view, the list's density and preview lines, and the folder icons. */
const LAYOUT_ROWS = ['viewStyle', 'listDensity', 'listPreviewLines', 'folderIconStyle'];

/** A folder's own colour is picked by holding it in the drawer, not by a right click. */
const LAYOUT_HINTS = { 'folderIconStyle.colorful': 'mobile.drawer.folderIconsColorfulHint' };

/** The list's sample: two rows as the list draws them, at `density` and `previewLines`. */
function ListSample({ density, previewLines }) {
  const t = useT();
  const prefs = { ...useMobileStore((s) => s.prefs), listDensity: density, listPreviewLines: previewLines };
  const rows = [
    { uid: 1, fromName: 'Nell Okafor', subject: t('settings.preview.subject'), dateMs: SAMPLE_DATE.getTime(), snippet: t('listPreview.sample'), seen: false },
    { uid: 2, fromName: 'Priya Raines', subject: t('preview.row4.subject'), dateMs: FIRST_REPLY.getTime(), snippet: t('listPreview.sample'), seen: true },
  ];
  return (
    <div className="mv-list-sample">
      {rows.map((row) => (
        <div key={row.uid} className="mv-row-slot" style={{ height: `${rowHeight(prefs)}px` }}>
          <RowFace row={row} prefs={prefs} as="div" />
        </div>
      ))}
    </div>
  );
}

function Layout({ save }) {
  const prefs = useMobileStore((s) => s.prefs);
  return <WorkspaceView values={prefs} rows={LAYOUT_ROWS} hintKeys={LAYOUT_HINTS} onChange={(key, value) => save({ [key]: value })}
    preview={{ chatSample: <SampleConversationView compact />, listSample: (sample) => <ListSample {...sample} /> }} />;
}

/** Reading less the row highlight, which follows a pointer the phone has not got. */
const READING_ROWS = ['threadMode', 'threadSortOrder', 'signatureDisplay', 'actionButtonDisplay'];

function Reading({ save }) {
  const prefs = useMobileStore((s) => s.prefs);
  return <ReadingView values={prefs} rows={READING_ROWS} onChange={(key, value) => save({ [key]: value })} />;
}

/** A custom pattern is written once typing pauses, not on every key. */
const TYPING_PAUSE_MS = 500;

function DateTime({ save }) {
  const prefs = useMobileStore((s) => s.prefs);
  const [draft, setDraft] = useState(null);
  const timer = useRef(null);
  // The typed pattern not written yet, and the latest writer: leaving the page writes it.
  const pending = useRef(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    const value = pending.current;
    if (value === null) return;
    pending.current = null;
    // Only the draft this write carried gives way to the stored value; a newer one stays.
    Promise.resolve(saveRef.current({ customDateFormat: value })).finally(() => setDraft((d) => (d === value ? null : d)));
  }, []);
  useEffect(() => flush, [flush]);
  const onChange = (key, value) => {
    if (key !== 'customDateFormat') return save({ [key]: value });
    setDraft(value);
    pending.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, TYPING_PAUSE_MS);
    return undefined;
  };
  const values = draft === null ? prefs : { ...prefs, customDateFormat: draft };
  return <DateTimeView values={values} onChange={onChange} systemLanguage={typeof navigator !== 'undefined' ? navigator.language : ''} />;
}

function Language({ version }) {
  const [active, setActive] = useState(getMobileLocale());
  const pick = (code) => {
    setActive(code);
    // A failed write still switches this run; the next launch then follows the system.
    daemonCall('mobile.settings.set', { language: code }).catch(() => {});
    loadMobileLocale([code], code);
  };
  return (
    <LanguageView active={active} onPick={pick}>
      <TranslationIssueReportView initialLang={active}
        onSubmit={({ lang, wrong, fix, where }) => openExternal(translationReportUrl({ lang, version, wrong, fix, where }))} />
    </LanguageView>
  );
}

/** `section`: the section to open on (a search result's); `onSectionChange` follows the tabs. */
export default function Appearance({ section: wanted = 'colors', onSectionChange, version = APP_VERSION }) {
  const [section, setSection] = useState(() => validAppearanceSection(wanted));
  useEffect(() => setSection(validAppearanceSection(wanted)), [wanted]);
  const [save, failed] = useSavePrefs();
  return (
    <MobileViewEnv>
      <AppearanceView section={section} onSectionChange={(value) => { setSection(value); onSectionChange?.(value); }}>
        {section === 'colors' && <ColorScheme save={save} />}
        {section === 'text' && <Text save={save} />}
        {section === 'layout' && <Layout save={save} />}
        {section === 'reading' && <Reading save={save} />}
        {section === 'date-time' && <DateTime save={save} />}
        {section === 'quick-actions' && <QuickActions />}
        {section === 'language' && <Language version={version} />}
        <SaveFailed failed={failed} />
      </AppearanceView>
    </MobileViewEnv>
  );
}
