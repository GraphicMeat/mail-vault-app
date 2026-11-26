// The message viewer. The header (subject, sender, recipients, date) comes from the list row, so it
// paints on the tap; the body follows from `mobile.message.body` and is drawn in an iframe whose
// document `prepareMailBody` + `assembleMailFrame` build (mailFrame.js: CSP first, links out of the frame, hostile parts
// taken out). The frame is sandboxed with popups only, so a link opens in the system browser and
// the mail can never run script or reach the app's origin. Remote images stay blocked by the CSP
// until the user taps "Load images", which mounts a new frame with https: images allowed; with
// `holdExternalContent` off (a desktop that loads them) they load at once, unless the body still
// carries tracker pixels (a free phone keeps them): then the button stays.
// The perf probe's tap-to-paint mark (`viewerPainted`) is raised after the first paint of the
// header, never on the body: the gate measures navigation, not the network.
// Each attachment is a chip (AttachmentChip.jsx): tap downloads, opens or retries, a long press
// shares. A link tapped in the mail leaves the frame for the system browser: the shell's
// navigation hook (src-tauri-mobile/native) cancels it in the webview and hands the URL out.
// Link safety (Settings > Privacy & security): the engine scans the links while
// `linkSafetyEnabled` is on and sends the flagged ones (`alerts`, reasons written from the
// `linkSafety.reason.*` templates sent with the request); the frame marks them, and with
// `linkSafetyClickConfirm` a flagged link no longer holds its URL (mailFrame.js `markLinks`): a
// tap on it only reloads the frame, and the frame's next `load` opens LinkSheet, the app's own
// warning with the real URLs, whose Open anyway is the only way to one. The mail is drawn again
// at once.
// The toolbar at the bottom acts on the message: the actions `quickActionsReader` puts on it
// (Settings > Appearance > Quick actions, quickActions.js; by default read or unread, flag, move
// over MovePicker.jsx and delete); App.jsx sends the actions (store `act`). Its More button opens a
// sheet with every other action the phone has, Reply, Reply all and Forward among them
// (`onCompose(mode)`: App.jsx opens Compose.jsx). Spam moves the message to the account's Junk
// folder and is offered only where there is one.
// With AI on (Settings > AI) More also has Summarize, desktop's viewer action: reviewed
// (AiActions.jsx), its result in a sheet with "Use in reply". Quick replies (QuickReplies.jsx) sit
// above the toolbar once the body is in: a tap opens a reply with that starter.
// The message's local labels (desktop's tags) show under its header, each removable; More's Apply
// local label opens TagSheet.jsx to apply, make or remove them. Its custom fields (desktop's
// property strip, FieldStrip.jsx) follow, each editable in place, when its account has any.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { displayText } from '../utils/bidiText.js';
import { daemonCall } from './transport.js';
import { assembleMailFrame, prepareMailBody } from './mailFrame.js';
import { formatFullDate } from './format.js';
import { ERROR_KEYS, errorKey } from './errors.js';
import { afterNextPaint, bodyLoaded, notePrepare, viewerPainted } from './perf.js';
import { useT } from './i18n.js';
import MovePicker from './MovePicker.jsx';
import TagChips from './TagChips.jsx';
import KeepButton from './KeepButton.jsx';
import TagSheet from './TagSheet.jsx';
import FieldStrip from './FieldStrip.jsx';
import Sheet from './Sheet.jsx';
import AttachmentChip from './AttachmentChip.jsx';
import { useBackLayer } from './backStack.js';
import { EnvelopeIcon, FlagIcon, ForwardIcon, MoreIcon, MoveIcon, ReplyAllIcon, ReplyIcon, ShieldIcon, SpamIcon, TrashIcon } from './icons.jsx';
import { junkFolder, splitReader } from './quickActions.js';
import { openPaywall } from './premium.js';
import { useInlineImages, withInlineImages } from './inlineImages.js';
import { bareContentId, htmlReferencesCid } from '../utils/cidRefs.js';
import { useMobileStore } from './store.js';
import { viewerTheme } from './prefs.js';
import QuickReplies from './QuickReplies.jsx';
import { AiResult, useAiAction } from './AiActions.jsx';
import { Button } from '../components/ui/Button.jsx';

/** Exactly this, never more: no `allow-same-origin`, no `allow-scripts`. */
export const FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

/**
 * The message's theme: Settings > Appearance's email viewer theme, else the app's theme, else the
 * system's (mobile.css follows the same rule for the app).
 */
function useAppTheme() {
  const prefs = useMobileStore((s) => s.prefs);
  const query = useMemo(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(LIGHT_QUERY) : null), []);
  const [light, setLight] = useState(() => Boolean(query?.matches));
  useEffect(() => {
    if (!query?.addEventListener) return undefined;
    const onChange = (e) => setLight(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [query]);
  return viewerTheme(light, prefs);
}

/** The engine answers a network failure as `INTERNAL` with the accounts code as the message. */
function failureCode(err) {
  if (err?.code === 'INTERNAL' && Object.hasOwn(ERROR_KEYS, err.message)) return err.message;
  return err?.code;
}

function recipientsOf(row) {
  const to = Array.isArray(row.to) ? row.to : [];
  return to.map((a) => displayText(a?.name, '') || displayText(a?.address, '')).filter(Boolean).join(', ');
}

function Header({ row }) {
  const t = useT();
  const name = displayText(row.fromName, '');
  const address = displayText(row.fromAddress, '');
  const to = recipientsOf(row);
  const prefs = useMobileStore((s) => s.prefs);
  const date = formatFullDate(row.dateMs, prefs);
  return (
    <div className="mv-viewer__header">
      <h1 className="mv-viewer__subject" dir="auto">{displayText(row.subject, t('common.noSubject'))}</h1>
      <dl className="mv-viewer__meta">
        <div className="mv-viewer__line">
          <dt>{t('common.from')}</dt>
          <dd dir="auto">
            <span className="mv-viewer__name">{name || address || t('explorer.unknownSender')}</span>
            {name && address && <span className="mv-viewer__address">{address}</span>}
          </dd>
        </div>
        {to && (
          <div className="mv-viewer__line">
            <dt>{t('common.to')}</dt>
            <dd dir="auto">{to}</dd>
          </div>
        )}
      </dl>
      {date && <time className="mv-viewer__date" dateTime={new Date(row.dateMs).toISOString()}>{date}</time>}
    </div>
  );
}

function Attachments({ accountId, folder, uid, items }) {
  const t = useT();
  // `autoDownloadAttachments`: each chip fetches its file as the message opens.
  const autoFetch = useMobileStore((s) => s.prefs.autoDownloadAttachments === true);
  if (items.length === 0) return null;
  return (
    <ul className="mv-viewer__chips" aria-label={t('common.attachmentCount', { count: items.length })}>
      {items.map((a) => (
        <AttachmentChip key={a.section} accountId={accountId} folder={folder} uid={uid} attachment={a} autoFetch={autoFetch} />
      ))}
    </ul>
  );
}

/** One toolbar button, as `actionButtonDisplay` shows it: its icon, its icon over its label, or its
 *  label alone. The label is always its accessible name. */
function Tool({ name, label, display, className = 'mv-tool', pressed, onClick, children }) {
  return (
    <button
      type="button"
      className={display === 'icon-only' ? className : `${className} mv-tool--labelled`}
      data-mv-tool={name}
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
    >
      {display !== 'text-only' && children}
      {display !== 'icon-only' && <span className="mv-tool__label" aria-hidden="true">{label}</span>}
    </button>
  );
}

const COMPOSE_MODES = new Set(['reply', 'replyAll', 'forward']);
/** The bar's `data-mv-tool` for an action (the read toggle has always been `seen`). */
const TOOL_ID = { toggleRead: 'seen' };
const DANGER = new Set(['delete', 'spam']);

/** The catalog key of an action's label for this message (the toggles name what a tap does). */
function actionLabelKey(action, seen, flagged) {
  switch (action) {
    case 'toggleRead': return seen ? 'mobile.actions.markUnread' : 'mobile.actions.markRead';
    case 'flag': return flagged ? 'mobile.actions.unflag' : 'mobile.actions.flag';
    case 'move': return 'mobile.actions.move';
    case 'delete': return 'common.delete';
    case 'spam': return 'quickActions.action.spam';
    case 'reply': return 'emailActionBar.reply';
    case 'replyAll': return 'emailActionBar.replyAll';
    default: return 'emailActionBar.forward';
  }
}

function ActionIcon({ action, seen, flagged }) {
  switch (action) {
    case 'toggleRead': return <EnvelopeIcon open={seen} />;
    case 'flag': return <FlagIcon filled={flagged} />;
    case 'move': return <MoveIcon />;
    case 'delete': return <TrashIcon />;
    case 'spam': return <SpamIcon />;
    case 'reply': return <ReplyIcon />;
    case 'replyAll': return <ReplyAllIcon />;
    default: return <ForwardIcon />;
  }
}

/** The bar: the actions of `quickActionsReader` (quickActions.js), then More for the rest. */
function Toolbar({ bar, more, seen, flagged, onRun, onMore }) {
  const t = useT();
  const pref = useMobileStore((s) => s.prefs.actionButtonDisplay);
  const display = ['icon-label', 'text-only'].includes(pref) ? pref : 'icon-only';
  return (
    <div className="mv-viewer__toolbar" role="toolbar" aria-label={t('mobile.actions.toolbar')} data-mv-buttons={display}>
      {bar.map((action) => (
        <Tool
          key={action}
          name={TOOL_ID[action] || action}
          display={display}
          className={`mv-tool${DANGER.has(action) ? ' mv-tool--danger' : ''}`}
          pressed={action === 'flag' ? (flagged ? 'true' : 'false') : undefined}
          label={t(actionLabelKey(action, seen, flagged))}
          onClick={() => onRun(action)}
        >
          <ActionIcon action={action} seen={seen} flagged={flagged} />
        </Tool>
      ))}
      {more.length > 0 && (
        <Tool name="more" display={display} label={t('mobile.viewer.more')} onClick={onMore}>
          <MoreIcon />
        </Tool>
      )}
    </div>
  );
}

/** More: every action the bar does not show. Reply, Reply all and Forward keep `data-mv-compose-mode`. */
function MoreSheet({ actions, seen, flagged, onPick, onClose, onSummarize, onTags }) {
  const t = useT();
  return (
    <Sheet kind="sheet" label={t('mobile.viewer.more')} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <div className="mv-sheet__actions">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={`mv-sheet__action${DANGER.has(action) ? ' mv-sheet__action--danger' : ''}`}
            data-mv-compose-mode={COMPOSE_MODES.has(action) ? action : undefined}
            data-mv-more-action={action}
            onClick={() => onPick(action)}
          >
            {t(actionLabelKey(action, seen, flagged))}
          </button>
        ))}
        {onSummarize && (
          <button type="button" className="mv-sheet__action" data-mv-ai-action="summarize" onClick={onSummarize}>
            {t('ai.actions.summarize')}
          </button>
        )}
        {onTags && (
          <button type="button" className="mv-sheet__action" data-mv-tags-open onClick={onTags}>
            {t('quickActions.action.tag')}
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** The tracking pixels the message carried, named (vendor and host; never the URL). */
function TrackerSheet({ count, list, onClose }) {
  const t = useT();
  return (
    <Sheet kind="sheet" label={t('alert.tracker.trackingBlocked', { count })} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('alert.tracker.trackingBlocked', { count })}</h2>
      <p className="mv-sheet__note">{t('alert.tracker.removed', { count })}</p>
      <ul className="mv-trackers" data-mv-tracker-list>
        {list.map((tr, i) => (
          <li key={i} className="mv-trackers__item">
            <span className="mv-trackers__vendor" dir="auto">{displayText(tr.vendor, '')}</span>
            {tr.domain && tr.domain !== tr.vendor && <span className="mv-trackers__domain">{displayText(tr.domain, '')}</span>}
          </li>
        ))}
      </ul>
      <div className="mv-sheet__actions">
        <button type="button" className="mv-sheet__action" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Sheet>
  );
}

/** The shield in the bar: with the count once Premium has removed the pixels (tap for the list),
 *  locked while they were kept (tap for the paywall; with Premium, whose blocking was turned off in
 *  Settings > Privacy & security, the list). */
function TrackerShield({ count, stripped, onOpen }) {
  const t = useT();
  const premium = useMobileStore((s) => s.premium?.premium === true);
  const label = stripped ? t('alert.tracker.trackingBlocked', { count }) : t('alert.tracker.emailTracks', { count });
  return (
    <button
      type="button"
      className={`mv-viewer__shield${stripped ? '' : ' mv-viewer__shield--locked'}`}
      data-mv-tracker-shield={stripped ? 'blocked' : 'locked'}
      aria-label={label}
      style={{ minHeight: '44px', minWidth: '44px' }}
      onClick={stripped || premium ? onOpen : () => openPaywall('trackerBlocking')}
    >
      <ShieldIcon state={stripped ? 'blocked' : 'locked'} />
      {stripped && <span className="mv-viewer__shield-count" aria-hidden="true">{count}</span>}
    </button>
  );
}

const noop = () => {};

const LINK_REASONS = ['dangerousScheme', 'textMismatch', 'redirect', 'ipAddress'];
/** A link the Open anyway button may carry (a flagged `javascript:` or `data:` gets none). */
const WEB_URL = /^\s*https?:\/\//i;

/** The app's warning before a flagged link opens: every flagged link of the message, with its
 *  text, its real URL and the reason, each with Open anyway (web links only); Cancel closes. */
function LinkSheet({ alerts, onClose }) {
  const t = useT();
  const red = alerts.some((a) => a.level === 'red');
  const title = red ? t('linkSafety.dangerousLinkDetected') : t('linkSafety.suspiciousLinkDetected');
  return (
    <Sheet kind="sheet" label={title} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className={`mv-sheet__title mv-linksheet__title mv-linksheet__title--${red ? 'red' : 'yellow'}`} data-mv-link-sheet={red ? 'red' : 'yellow'}>{title}</h2>
      <ul className="mv-linksheet">
        {alerts.map((a, i) => (
          <li key={i} className="mv-linksheet__item" data-mv-link-alert={a.level}>
            {a.reason && <p className="mv-sheet__note">{a.reason}</p>}
            <p className="mv-linksheet__label">{t('linkSafety.linkTextSays')}</p>
            <p className="mv-linksheet__value" dir="auto">{displayText(a.textContent, '')}</p>
            <p className="mv-linksheet__label">{t('linkSafety.actuallyRedirects')}</p>
            <p className="mv-linksheet__value mv-linksheet__url" dir="ltr">{a.actualUrl}</p>
            {WEB_URL.test(a.actualUrl) && (
              // The sheet closes after this click has run its course: a link taken out of the
              // page before its own activation opens nothing.
              <a className="mv-linksheet__open" data-mv-link-open href={a.actualUrl} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(onClose, 0)}>
                {t('linkSafety.openAnyway')}
              </a>
            )}
          </li>
        ))}
      </ul>
      <div className="mv-sheet__actions">
        <button type="button" className="mv-sheet__action" data-mv-link-cancel onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </Sheet>
  );
}

/** The engine writes link-safety reasons from these templates, in the UI language. `translate` is
 *  the viewer's own `useT()` (a helper holds no hook), so the texts follow a language change. */
function linkTexts(translate) {
  return Object.fromEntries(LINK_REASONS.map((k) => [`linkSafety.reason.${k}`, translate(`linkSafety.reason.${k}`)]));
}

export default function Viewer({ accountId, folder, row, onClose, folders = [], onAction = noop, onMove = noop, onDelete = noop, onCompose = noop, initialPicking = false }) {
  const t = useT();
  const [seen, setSeen] = useState(row.seen !== false);
  const [flagged, setFlagged] = useState(Boolean(row.flagged));
  // The row can change under an open viewer (a delayed `markAsReadMode` marks it read): follow it.
  useEffect(() => { setSeen(row.seen !== false); }, [row.seen]);
  useEffect(() => { setFlagged(Boolean(row.flagged)); }, [row.flagged]);
  const [picking, setPicking] = useState(initialPicking);
  const closePicker = useCallback(() => setPicking(false), []);
  useBackLayer(picking, closePicker);
  const [trackerList, setTrackerList] = useState(false);
  const closeTrackers = useCallback(() => setTrackerList(false), []);
  useBackLayer(trackerList, closeTrackers);
  const [more, setMore] = useState(false);
  const closeMore = useCallback(() => setMore(false), []);
  useBackLayer(more, closeMore);
  const [tagging, setTagging] = useState(false);
  const closeTags = useCallback(() => setTagging(false), []);
  useBackLayer(tagging, closeTags);
  const prefs = useMobileStore((s) => s.prefs);
  const junk = junkFolder(folders);
  const { bar, more: moreActions } = splitReader(prefs.quickActionsReader, (a) => a !== 'spam' || Boolean(junk && junk.path !== folder));
  const startCompose = (mode, starter) => {
    setMore(false);
    if (starter) onCompose(mode, starter);
    else onCompose(mode);
  };
  // Summarize (Settings > AI on): reviewed, then read in a sheet.
  const aiEnabled = useMobileStore((s) => s.prefs.aiEnabled === true);
  const ai = useAiAction();
  const [summary, setSummary] = useState(null);
  const closeSummary = useCallback(() => setSummary(null), []);
  useBackLayer(summary != null, closeSummary);
  useEffect(() => {
    if (ai.error) {
      useMobileStore.setState({ notice: { id: Date.now(), key: ai.error } });
      ai.clearError();
    }
  }, [ai.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const summarize = () => {
    setMore(false);
    ai.start({ action: 'summarize', accountId, folder, uid: row.uid }, setSummary);
  };
  // Optimistic: the button flips at once and flips back if the engine refused the apply.
  const toggle = (value, setValue, on, off) => {
    const next = !value;
    setValue(next);
    Promise.resolve(onAction(next ? on : off)).then(
      (r) => { if (r && r.ok === false) setValue((v) => (v === next ? !next : v)); },
      () => setValue((v) => (v === next ? !next : v)),
    );
  };
  const toggleSeen = () => toggle(seen, setSeen, 'seen', 'unseen');
  const toggleFlag = () => toggle(flagged, setFlagged, 'flag', 'unflag');
  const pick = (target) => {
    setPicking(false);
    onMove(target);
  };
  // One action from the bar or More. Spam is the desktop's: a move to the account's Junk folder.
  const run = (action) => {
    setMore(false);
    if (COMPOSE_MODES.has(action)) onCompose(action);
    else if (action === 'toggleRead') toggleSeen();
    else if (action === 'flag') toggleFlag();
    else if (action === 'move') setPicking(true);
    else if (action === 'delete') onDelete();
    else if (action === 'spam' && junk) onMove(junk.path);
  };
  const theme = useAppTheme();
  const [state, setState] = useState({ phase: 'loading' }); // loading | ready | gone | failed
  const [allowRemote, setAllowRemote] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(() => {
    if (typeof requestAnimationFrame === 'function' && typeof MessageChannel === 'function') {
      afterNextPaint(viewerPainted);
    }
  }, []);

  useEffect(() => {
    let live = true;
    setState({ phase: 'loading' });
    daemonCall('mobile.message.body', { accountId, folder, uid: row.uid, texts: linkTexts(t) }).then(
      (body) => {
        if (live) setState(body?.gone ? { phase: 'gone' } : { phase: 'ready', body });
      },
      (err) => {
        if (live) setState({ phase: 'failed', code: failureCode(err) });
      },
    );
    return () => { live = false; };
  }, [accountId, folder, row.uid, attempt, t]);

  const body = state.phase === 'ready' ? state.body : null;
  const locked = body?.pgp === 'locked';
  const hasContent = Boolean(body && !locked && ((body.html && body.html.trim()) || (body.text && body.text.trim())));
  const trackerLabel = t('mobile.viewer.trackerBlocked');
  // The expensive part (parse, clean, re-parse to a fixpoint, check) once per body; Load images
  // and a theme change only re-assemble our head around it (string work).
  const rawHtml = body?.html;
  const text = body?.text;
  const allAttachments = body?.attachments || [];
  // Inline `cid:` images, from the parts on the phone as `data:` URLs (inlineImages.js).
  const images = useInlineImages({ accountId, folder, uid: row.uid, html: rawHtml, attachments: body?.attachments });
  const html = useMemo(() => withInlineImages(rawHtml, images), [rawHtml, images]);
  const linkSafety = useMobileStore((s) => s.prefs.linkSafetyEnabled !== false);
  const confirmLinks = useMobileStore((s) => s.prefs.linkSafetyEnabled !== false && s.prefs.linkSafetyClickConfirm !== false);
  const alerts = linkSafety ? body?.alerts : null;
  // `signatureDisplay`: a signature folded under "Show signature", hidden, or shown (mailFrame.js).
  const signatureDisplay = useMobileStore((s) => s.prefs.signatureDisplay);
  const sigShow = t('util.iframeQuoteFolding.showSignature');
  const prepared = useMemo(() => {
    if (!hasContent) return null;
    const t0 = performance.now();
    const out = prepareMailBody({ html, text }, undefined, { alerts, confirm: confirmLinks, safety: linkSafety }, { mode: signatureDisplay, label: sigShow });
    notePrepare(performance.now() - t0, (html || text || '').length);
    return out;
  }, [html, text, hasContent, alerts, confirmLinks, linkSafety, signatureDisplay, sigShow]);
  const preparedRef = useRef(prepared);
  preparedRef.current = prepared;
  // A guarded link's tap reloads the frame: every load after its first is one. The mail is put
  // back in a fresh frame (`frameRun`) and the app asks.
  const [linkSheet, setLinkSheet] = useState(false);
  const closeLinkSheet = useCallback(() => setLinkSheet(false), []);
  useBackLayer(linkSheet, closeLinkSheet);
  const [frameRun, setFrameRun] = useState(0);
  const frameLoads = useRef(0);
  // Each new frame (Load images, the theme, inline images, a tap's reload) starts its own count.
  const frameRef = useCallback((el) => { if (el) frameLoads.current = 0; }, []);
  const onFrameLoad = useCallback(() => {
    frameLoads.current += 1;
    if (frameLoads.current === 1) {
      bodyLoaded(performance.now());
      return;
    }
    setFrameRun((n) => n + 1);
    // Nothing flagged to list: the mail is put back, and no sheet (nor its Back layer) stays open.
    if (preparedRef.current?.linkAlerts?.length > 0) setLinkSheet(true);
  }, []);
  const autoImages = useMobileStore((s) => s.prefs.holdExternalContent === false);
  const remoteOn = allowRemote || Boolean(autoImages && body && !((body.trackers || 0) > 0 && !body.trackersStripped));
  const srcDoc = useMemo(
    () => (prepared ? assembleMailFrame(prepared, { allowRemote: remoteOn, theme, trackerLabel }) : null),
    [prepared, remoteOn, theme, trackerLabel],
  );
  // Every part is a chip, except an inline image the frame draws.
  const attachments = useMemo(
    () => allAttachments.filter((a) => !(a.contentId && images?.[bareContentId(a.contentId)] && htmlReferencesCid(rawHtml, a.contentId))),
    [allAttachments, images, rawHtml],
  );
  const remoteImages = body?.remoteImages || 0;
  // Tracker pixels are stripped for Premium only (core `tracker_policy`, decided by the engine on
  // every open): a free body keeps them, blocked with every other remote image until Load images,
  // which would load them too. The bar says so rather than implying they are gone, and the shield
  // in the top bar is locked (paywall) instead of counting.
  const pixelsKept = (body?.trackers || 0) > 0 && !body?.trackersStripped;
  const trackerCount = body?.trackers || 0;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <section className="mv-viewer" aria-modal="true" role="dialog" aria-label={displayText(row.subject, t('common.noSubject'))}>
      <div className="mv-viewer__top">
        <header className="mv-viewer__bar">
          <button type="button" className="mv-viewer__back" data-mv-viewer-close style={{ minHeight: '44px', minWidth: '44px' }} onClick={onClose}>
            {t('common.back')}
          </button>
          {trackerCount > 0 && <TrackerShield count={trackerCount} stripped={Boolean(body.trackersStripped)} onOpen={() => setTrackerList(true)} />}
          <KeepButton accountId={accountId} folder={folder} row={row} />
        </header>
        <Header row={row} />
        <TagChips accountId={accountId} folder={folder} uid={row.uid} removable className="mv-viewer__tags" />
        <FieldStrip accountId={accountId} folder={folder} uid={row.uid} className="mv-viewer__fields" />
        <Attachments accountId={accountId} folder={folder} uid={row.uid} items={attachments} />
      </div>
      {body?.attachmentsUnknown && (
        // The server could not list the attachments this time; the body was not cached, so a
        // retry asks again.
        <div className="mv-viewer__images" data-mv-attachments-unknown role="status">
          <span>{t('mobile.viewer.attachmentsUnknown')}</span>
          <Button variant="link" size="touch" className="flex-none" onClick={retry}>{t('common.retry')}</Button>
        </div>
      )}
      {body?.truncated && (
        // The server sent only the start of a very long message; the body was not cached.
        <div className="mv-viewer__images" data-mv-truncated role="status">
          <span>{t('mobile.viewer.truncated')}</span>
        </div>
      )}
      {remoteImages > 0 && !remoteOn && (
        <div className="mv-viewer__images">
          <span>{pixelsKept ? t('mobile.viewer.imagesTrack') : t('mobile.viewer.imagesBlocked')}</span>
          <Button variant="link" size="touch" className="flex-none" data-mv-load-images onClick={() => setAllowRemote(true)}>
            {t('mobile.viewer.loadImages', { count: remoteImages })}
          </Button>
        </div>
      )}
      {state.phase === 'loading' && <p className="mv-viewer__notice" role="status">{t('mobile.viewer.loading')}</p>}
      {state.phase === 'gone' && <p className="mv-viewer__notice">{t('mobile.viewer.gone')}</p>}
      {state.phase === 'failed' && (
        <div className="mv-viewer__notice" role="alert">
          <p>{t('mobile.viewer.loadFailed', { reason: t(errorKey(state.code)) })}</p>
          <Button variant="link" size="touch" className="flex-none" onClick={retry}>{t('common.retry')}</Button>
        </div>
      )}
      {/* OpenPGP (`pgp` from the engine): a body no imported key opens shows the notice instead
          of its ciphertext, as desktop's reader does; a decrypted one says so above the mail. */}
      {locked && (
        <div className="mv-viewer__notice" role="status" data-mv-pgp-locked>
          <p><strong>{t('pgp.lockedTitle')}</strong></p>
          <p>{t('pgp.lockedHint')}</p>
        </div>
      )}
      {body?.pgp === 'decrypted' && (
        <div className="mv-viewer__images" data-mv-pgp-decrypted role="status">
          <span>{t('pgp.decryptedBadge')}</span>
        </div>
      )}
      {state.phase === 'ready' && !hasContent && !locked && <p className="mv-viewer__notice">{t('mobile.viewer.empty')}</p>}
      {/* A fresh frame per change, never a changed srcdoc: iOS WKWebView drops a second srcdoc
          change made while the first loads, which kept the broken cid: version once the inline
          images arrived. */}
      {srcDoc && (
        <iframe
          key={`${remoteOn ? 'remote' : 'local'}-${theme}-${images ? Object.keys(images).length : 0}-${frameRun}`}
          className="mv-viewer__frame"
          title={t('mobile.viewer.frameTitle')}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          ref={frameRef}
          onLoad={onFrameLoad}
        />
      )}
      {!srcDoc && <div className="mv-viewer__fill" />}
      {state.phase === 'ready' && hasContent && (
        <QuickReplies accountId={accountId} folder={folder} uid={row.uid} onReply={(text) => startCompose('reply', text)} />
      )}
      <Toolbar bar={bar} more={moreActions} seen={seen} flagged={flagged} onRun={run} onMore={() => setMore(true)} />
      {picking && <MovePicker folders={folders} current={folder} onPick={pick} onClose={closePicker} />}
      {trackerList && <TrackerSheet count={trackerCount} list={body?.trackerList || []} onClose={closeTrackers} />}
      {more && <MoreSheet actions={moreActions} seen={seen} flagged={flagged} onPick={run} onClose={closeMore} onSummarize={aiEnabled && hasContent ? summarize : null}
        onTags={() => { setMore(false); setTagging(true); }} />}
      {tagging && <TagSheet accountId={accountId} folder={folder} uid={row.uid} onClose={closeTags} />}
      {ai.sheet}
      {summary != null && (
        <AiResult title={t('ai.actions.summarize')} text={summary} onClose={closeSummary} onUse={() => { setSummary(null); startCompose('reply', summary); }} />
      )}
      {linkSheet && prepared?.linkAlerts?.length > 0 && <LinkSheet alerts={prepared.linkAlerts} onClose={closeLinkSheet} />}
    </section>
  );
}
