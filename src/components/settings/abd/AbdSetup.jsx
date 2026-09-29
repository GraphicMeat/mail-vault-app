import React, { useEffect, useMemo, useState } from 'react';
import { Loader, Folder } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SegmentedChoice } from '../../ui/SegmentedChoice';
import AbdSummary from './AbdSummary';
import { folderLabel } from '../../abd/abdText';
import { useAbdStore } from '../../../stores/abdStore';
import * as abd from '../../../services/abd';
import { dateScopeFor, olderCutoffDate, yearBounds } from '../../../utils/abdScope';
import { formatDateLong } from '../../../utils/dateFormat';
import { formatCount } from '../../../utils/formatCount';
import { tErr, useT } from '../../../i18n/index.js';

/** How long a click on a checkbox waits for the next one before the dry run is asked again. */
export const SUMMARY_DEBOUNCE_MS = 250;

/** The years a date choice covers, out of the per-year list (all calendar years in the user's zone). */
export function yearsInScope(choice, years, { now = new Date(), picked = [] } = {}) {
  const year = now.getFullYear();
  switch (choice) {
    case 'this_year': return years.filter(y => y.year === year);
    case 'last_year': return years.filter(y => y.year === year - 1);
    // Jan 1 of (year - 2) is the cut-off, so every whole year up to year - 3 is older.
    case 'older_than_2': return years.filter(y => y.year <= year - 3);
    case 'years': return years.filter(y => picked.includes(y.year));
    default: return years;
  }
}

/** One radio: the label is its name, the sentence under it is its description. */
function ChoiceRow({ name, value, checked, disabled, onChange, label, hint, note, testId }) {
  const id = `${name}-${value}`;
  return (
    <div className={`flex items-start gap-2 py-1 ${disabled ? 'opacity-60' : ''}`}>
      <input type="radio" id={id} name={name} value={value} checked={checked} disabled={disabled} data-testid={testId}
        aria-describedby={`${id}-hint`} onChange={() => onChange(value)}
        className="mt-1 w-4 h-4 accent-[var(--mail-accent)]" />
      <div className="min-w-0">
        <label htmlFor={id} className={`block text-sm text-mail-text ${disabled ? '' : 'cursor-pointer'}`}>{label}</label>
        <p id={`${id}-hint`} className="text-xs text-mail-text-muted">
          {hint}
          {note && <span className="block text-mail-warning">{note}</span>}
        </p>
      </div>
    </div>
  );
}

/**
 * The setup screen of an Archive & delete job (part-d design 6.3): what to
 * remove (folders and dates), when and how to delete, then the daemon's dry
 * run and Start. The account's folders are listed once by the daemon (a
 * preview); every change of the selection asks that preview for a new summary,
 * which is computed from memory without touching the server.
 */
export default function AbdSetup({ account, mode, onBack, onStarted }) {
  const t = useT();
  const accountId = account.id;
  const preview = useAbdStore(s => s.previews[accountId]);

  const now = useMemo(() => new Date(), []);
  const bounds = useMemo(() => yearBounds(now), [now]);

  const [ticked, setTicked] = useState(null); // Set of folder paths; null until the first summary names them
  const [dateChoice, setDateChoice] = useState('all');
  const [pickedYears, setPickedYears] = useState([]);
  const [timing, setTiming] = useState('after_all');
  const [deleteMode, setDeleteMode] = useState('move_to_trash');
  const [summary, setSummary] = useState(null);
  const [summaryKey, setSummaryKey] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const [startCode, setStartCode] = useState(null);

  const startPreview = () => {
    setSummary(null);
    setSummaryKey(null);
    setSummaryError(null);
    setTicked(null);
    setConfirmed(false);
    setStartError(null);
    setStartCode(null);
    return abd.beginPreview(accountId);
  };

  useEffect(() => {
    abd.beginPreview(accountId);
    return () => useAbdStore.getState().clearPreview(accountId);
  }, [accountId]);

  const folders = useMemo(() => (ticked ? [...ticked].sort() : []), [ticked]);
  const scope = useMemo(() => dateScopeFor(dateChoice, { now, years: pickedYears }), [dateChoice, now, pickedYears]);
  const previewId = preview?.previewId;
  const ready = preview?.state === 'ready';
  const selectionKey = JSON.stringify([previewId, mode, folders, scope, dateChoice, deleteMode]);

  // A different selection is a different summary: the tick answered the old one.
  useEffect(() => { setConfirmed(false); }, [selectionKey]);

  // The dry run, asked again on every change once it has been asked once. The
  // first ask names no folders: the listing has not told the screen its
  // folders yet, and the summary carries a row for every one of them.
  useEffect(() => {
    if (!ready) return undefined;
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const next = await abd.summarize({
          accountId, previewId, mode, folders, dates: scope, dateChoice, yearBounds: bounds, deleteMode,
        });
        if (stale) return;
        setSummary(next);
        setSummaryKey(selectionKey);
        setSummaryError(null);
        if (ticked === null) setTicked(new Set((next.folders || []).map(f => f.path)));
      } catch (error) {
        if (!stale) setSummaryError(tErr(error));
      }
    }, summary ? SUMMARY_DEBOUNCE_MS : 0);
    return () => { stale = true; clearTimeout(timer); };
    // The key stands for every input of the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectionKey]);

  const toggleFolder = (path) => setTicked(prev => {
    const next = new Set(prev || []);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const allPaths = summary ? (summary.folders || []).map(f => f.path) : [];
  const allTicked = !!ticked && allPaths.length > 0 && allPaths.every(p => ticked.has(p));
  const toggleAll = () => setTicked(allTicked ? new Set() : new Set(allPaths));
  const toggleYear = (year) => setPickedYears(prev => (prev.includes(year) ? prev.filter(y => y !== year) : [...prev, year]));

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    setStartCode(null);
    try {
      await abd.startJob({
        accountId, previewId, mode, timing, deleteMode, folders,
        dates: scope, dateChoice, yearBounds: bounds, confirmed: true,
      });
      onStarted?.();
    } catch (error) {
      // The code decides what to offer; the sentence is the person's language, so it can not be matched.
      setStartCode(/\b(E_ABD_[A-Z_]+):/.exec(String(error?.message ?? error))?.[1] || null);
      setStartError(tErr(error));
    } finally {
      setStarting(false);
    }
  };

  const failed = preview?.state === 'failed';
  const listing = !failed && !summary;
  const canEmpty = summary ? summary.canEmpty !== false : true;
  const cutoff = formatDateLong(olderCutoffDate(now));
  const expired = startCode === 'E_ABD_PREVIEW_EXPIRED';

  return (
    <div className="space-y-5" data-testid="abd-setup">
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-semibold text-mail-text">{t('settings.backup.abd.setup.title')}</h4>
        <Button variant="ghost" size="sm" data-testid="abd-back" onClick={onBack}>{t('common.back')}</Button>
      </div>
      <p className="text-xs text-mail-text-muted">{account.email}</p>

      {failed && (
        <div role="alert" data-testid="abd-list-failed" className="space-y-2">
          <p className="text-sm text-mail-danger">{t('settings.backup.abd.setup.listFailed', { error: preview.error || '' })}</p>
          <Button variant="secondary" size="sm" onClick={startPreview}>{t('common.retry')}</Button>
        </div>
      )}

      {listing && (
        <div className="flex items-center gap-2 text-sm text-mail-text-muted" data-testid="abd-listing" role="status">
          <Loader size={16} className="animate-spin text-mail-accent-text" aria-hidden="true" />
          {preview?.folder
            ? t('settings.backup.abd.setup.listingProgress', { folder: folderLabel({ name: preview.folder }), count: formatCount(preview.listed || 0) })
            : t('settings.backup.abd.setup.listing')}
        </div>
      )}

      {summaryError && !failed && <p role="alert" className="text-sm text-mail-danger">{summaryError}</p>}

      {summary && (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-mail-text mb-1">{t('settings.backup.abd.setup.folders')}</legend>
            <label className="flex items-center gap-2 text-sm text-mail-text cursor-pointer">
              <input type="checkbox" data-testid="abd-whole-account" checked={allTicked} onChange={toggleAll}
                className="w-4 h-4 rounded border-mail-border accent-[var(--mail-accent)]" />
              <span>{t('settings.backup.abd.setup.wholeAccount')}</span>
            </label>
            <div className="max-h-64 overflow-y-auto space-y-0.5" data-testid="abd-folders">
              {(summary.folders || []).map(f => (
                <label key={f.path} className="flex items-center gap-2 p-1.5 rounded-lg cursor-pointer hover:bg-mail-surface-hover text-sm text-mail-text">
                  <input type="checkbox" data-testid={`abd-folder-${f.path}`} checked={!!ticked?.has(f.path)} onChange={() => toggleFolder(f.path)}
                    className="w-4 h-4 rounded border-mail-border accent-[var(--mail-accent)]" />
                  <Folder size={16} className="flex-shrink-0 text-mail-text-muted" aria-hidden="true" />
                  <span className="flex-1 truncate">{folderLabel(f)}</span>
                  <span className="text-xs text-mail-text-muted bg-mail-border px-1.5 py-0.5 rounded tabular-nums">{formatCount(f.count)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-2">
            <div className="text-sm font-medium text-mail-text">{t('settings.backup.abd.setup.dates')}</div>
            <SegmentedChoice
              label={t('settings.backup.abd.setup.dates')}
              value={dateChoice}
              onChange={setDateChoice}
              options={[
                { value: 'all', label: t('settings.backup.abd.setup.datesAll') },
                { value: 'this_year', label: t('settings.backup.abd.setup.datesThisYear') },
                { value: 'last_year', label: t('settings.backup.abd.setup.datesLastYear') },
                { value: 'older_than_2', label: t('settings.backup.abd.setup.datesOlder') },
                { value: 'years', label: t('settings.backup.abd.setup.datesChoose') },
              ]}
            />
            {dateChoice === 'older_than_2' && (
              <p className="text-xs text-mail-text-muted" data-testid="abd-cutoff">
                {t('settings.backup.abd.setup.datesOlderCutoff', { date: cutoff })}
              </p>
            )}
            {dateChoice === 'years' && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 max-h-48 overflow-y-auto" data-testid="abd-years">
                {(summary.years || []).map(y => (
                  <label key={y.year} className="flex items-center gap-2 text-sm text-mail-text cursor-pointer">
                    <input type="checkbox" data-testid={`abd-year-${y.year}`} checked={pickedYears.includes(y.year)} onChange={() => toggleYear(y.year)}
                      className="w-4 h-4 rounded border-mail-border accent-[var(--mail-accent)]" />
                    <span>{t('settings.backup.abd.setup.yearCount', { year: y.year, count: y.count })}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-mail-text-muted">{t('settings.backup.abd.setup.dateBasis')}</p>
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-mail-text mb-1">{t('settings.backup.abd.setup.when')}</legend>
            <ChoiceRow name="abd-when" value="after_all" checked={timing === 'after_all'} onChange={setTiming} testId="abd-when-after-all"
              label={t('settings.backup.abd.setup.whenAfterAll')} hint={t('settings.backup.abd.setup.whenAfterAllHint')} />
            <ChoiceRow name="abd-when" value="as_saved" checked={timing === 'as_saved'} onChange={setTiming} testId="abd-when-as-saved"
              label={t('settings.backup.abd.setup.whenAsSaved')} hint={t('settings.backup.abd.setup.whenAsSavedHint')} />
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium text-mail-text mb-1">{t('settings.backup.abd.setup.how')}</legend>
            <ChoiceRow name="abd-how" value="move_to_trash" checked={deleteMode === 'move_to_trash'} onChange={setDeleteMode} testId="abd-how-trash"
              label={t('settings.backup.abd.setup.howTrash')} hint={t('settings.backup.abd.setup.howTrashHint')} />
            <ChoiceRow name="abd-how" value="move_to_trash_and_empty" checked={deleteMode === 'move_to_trash_and_empty'} onChange={setDeleteMode}
              testId="abd-how-empty" disabled={!canEmpty}
              label={t('settings.backup.abd.setup.howEmpty')} hint={t('settings.backup.abd.setup.howEmptyHint')}
              note={!canEmpty ? t('settings.backup.abd.setup.cannotEmpty') : null} />
          </fieldset>

          <AbdSummary
            summary={summary}
            mode={mode}
            folders={ticked || new Set()}
            years={yearsInScope(dateChoice, summary.years || [], { now, picked: pickedYears })}
            stale={summaryKey !== selectionKey}
            confirmed={confirmed}
            onConfirm={setConfirmed}
            onStart={start}
            starting={starting}
            error={startError}
            onRetry={expired ? startPreview : null}
          />
        </>
      )}
    </div>
  );
}
