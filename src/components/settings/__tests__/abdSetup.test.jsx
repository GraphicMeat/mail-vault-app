// @vitest-environment jsdom
// The setup screen: scope selection, the dry-run summary, and Start.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const svc = vi.hoisted(() => ({
  beginPreview: vi.fn(async () => 'p1'),
  summarize: vi.fn(),
  startJob: vi.fn(async () => ({ jobId: 'abd-acc-1' })),
}));
vi.mock('../../../services/abd', () => svc);

import AbdSetup, { yearsInScope } from '../abd/AbdSetup';
import { useAbdStore } from '../../../stores/abdStore';
import { formatDateLong } from '../../../utils/dateFormat';
import { formatBytes } from '../../../utils/formatBytes';
import { t } from '../../../i18n';

const ACCOUNT = { id: 'acc', email: 'luke@mock.test' };
const YEAR = new Date().getFullYear();

const folder = (over) => ({
  path: 'INBOX', name: 'INBOX', role: 'normal', count: 1200, bytes: 98_765_432,
  alreadyArchived: 800, alreadyOnDrive: 700, byYear: [], ...over,
});
const SUMMARY = {
  previewId: 'p1', provider: 'imap', canDelete: true, canEmpty: true,
  folders: [
    folder({}),
    folder({ path: 'Archive', name: 'Archive', count: 20, bytes: 1000, alreadyArchived: 0, alreadyOnDrive: 0 }),
    folder({ path: 'Trash', name: 'Trash', role: 'trash', count: 3, bytes: 300, alreadyArchived: 0, alreadyOnDrive: 0 }),
  ],
  years: [
    { year: 2019, count: 10, bytes: 1000 },
    { year: YEAR - 3, count: 300, bytes: 2000 },
    { year: YEAR - 1, count: 900, bytes: 3000 },
    { year: YEAR, count: 13, bytes: 4000 },
  ],
  total: { count: 1223, bytes: 99_000_000, uniqueMessages: 1223, toDownloadBytes: 55_000_000 },
  estimate: { dailyLimitBytes: 2_000_000_000, allowanceLeftBytes: 1_500_000_000, days: 2, gmailCap: false },
  warnings: [],
};

const ready = () => useAbdStore.setState({
  previews: { [ACCOUNT.id]: { previewId: 'p1', state: 'ready', folder: null, listed: 0, error: null } },
});
const renderSetup = (props = {}) => render(<AbdSetup account={ACCOUNT} mode="archive_delete" onBack={() => {}} onStarted={() => {}} {...props} />);
/** The summary on screen answers the current selection, and the first summary's folders are ticked. */
const fresh = () => waitFor(() => {
  expect(screen.getByTestId('abd-summary').hasAttribute('data-stale')).toBe(false);
});
const settled = async () => {
  await waitFor(() => expect(screen.getByTestId('abd-folder-INBOX').checked).toBe(true));
  await fresh();
};
const lastCall = () => svc.summarize.mock.calls.at(-1)[0];
const radio = (name) => screen.getByRole('radio', { name });

beforeEach(() => {
  vi.clearAllMocks();
  svc.summarize.mockImplementation(async () => SUMMARY);
  svc.startJob.mockImplementation(async () => ({ jobId: 'abd-acc-1' }));
  useAbdStore.setState({ jobs: {}, previews: {}, panel: null });
});
afterEach(cleanup);

describe('listing the folders', () => {
  it('shows the listing while the daemon reads, with the folder it is on', () => {
    useAbdStore.setState({ previews: { [ACCOUNT.id]: { previewId: 'p1', state: 'listing', folder: 'INBOX', listed: 4200, error: null } } });
    renderSetup();
    expect(screen.getByTestId('abd-listing').textContent).toBe(t('settings.backup.abd.setup.listingProgress', { folder: 'INBOX', count: '4,200' }));
    expect(svc.summarize).not.toHaveBeenCalled();
  });

  it('asks for a fresh listing when it opens, and drops it when it closes', () => {
    const view = renderSetup();
    expect(svc.beginPreview).toHaveBeenCalledWith(ACCOUNT.id);
    useAbdStore.setState({ previews: { [ACCOUNT.id]: { previewId: 'p1', state: 'listing', folder: null, listed: 0, error: null } } });
    view.unmount();
    expect(useAbdStore.getState().previews[ACCOUNT.id]).toBeUndefined();
  });

  it('says why a listing failed and offers a retry', () => {
    useAbdStore.setState({ previews: { [ACCOUNT.id]: { previewId: 'p1', state: 'failed', folder: null, listed: 0, error: 'timed out' } } });
    renderSetup();
    expect(screen.getByTestId('abd-list-failed').textContent).toContain(t('settings.backup.abd.setup.listFailed', { error: 'timed out' }));
    svc.beginPreview.mockClear();
    fireEvent.click(within(screen.getByTestId('abd-list-failed')).getByText(t('common.retry')));
    expect(svc.beginPreview).toHaveBeenCalledWith(ACCOUNT.id);
  });
});

describe('folders', () => {
  it('asks the first summary for no folders, then ticks every folder it names', async () => {
    ready();
    renderSetup();
    await waitFor(() => expect(svc.summarize).toHaveBeenCalled());
    expect(svc.summarize.mock.calls[0][0].folders).toEqual([]);
    await settled();
    for (const path of ['INBOX', 'Archive', 'Trash']) expect(screen.getByTestId(`abd-folder-${path}`).checked, path).toBe(true);
    expect(screen.getByTestId('abd-whole-account').checked).toBe(true);
    expect(lastCall().folders).toEqual(['Archive', 'INBOX', 'Trash']);
  });

  it('shows each folder with its email count', async () => {
    ready();
    renderSetup();
    await settled();
    const inbox = screen.getByTestId('abd-folder-INBOX').closest('label');
    expect(inbox.textContent).toContain('INBOX');
    expect(inbox.textContent).toContain('1,200');
  });

  it('unticking one folder and Whole account narrow and widen the request', async () => {
    ready();
    renderSetup();
    await settled();
    fireEvent.click(screen.getByTestId('abd-folder-Trash'));
    await waitFor(() => expect(lastCall().folders).toEqual(['Archive', 'INBOX']));
    expect(screen.getByTestId('abd-whole-account').checked).toBe(false);
    fireEvent.click(screen.getByTestId('abd-whole-account'));
    await waitFor(() => expect(lastCall().folders).toEqual(['Archive', 'INBOX', 'Trash']));
    fireEvent.click(screen.getByTestId('abd-whole-account'));
    await waitFor(() => expect(lastCall().folders).toEqual([]));
  });

  it('labels Gmail\'s All Mail for what it holds here', async () => {
    svc.summarize.mockImplementation(async () => ({
      ...SUMMARY,
      folders: [...SUMMARY.folders, folder({ path: '[Gmail]/All Mail', name: 'All Mail', role: 'all_mail', count: 40 })],
    }));
    ready();
    renderSetup();
    await settled();
    const row = screen.getByTestId('abd-folder-[Gmail]/All Mail').closest('label');
    expect(row.textContent).toContain(t('settings.backup.abd.setup.allMailGmail'));
  });
});

describe('dates', () => {
  it('starts on All dates and sends every year\'s local bounds', async () => {
    ready();
    renderSetup();
    await settled();
    const call = lastCall();
    expect(call.dates).toEqual({ kind: 'all' });
    expect(call.dateChoice).toBe('all');
    expect(call.yearBounds[0].year).toBe(1970);
    expect(call.yearBounds.at(-1).year).toBe(YEAR + 1);
    expect(call.yearBounds.find(b => b.year === YEAR).startMs).toBe(new Date(YEAR, 0, 1).getTime());
  });

  it('shows the exact cut-off of "Older than 2 years": Jan 1 two years back, in local time', async () => {
    ready();
    renderSetup();
    await settled();
    expect(screen.queryByTestId('abd-cutoff')).toBeNull();
    fireEvent.click(radio(t('settings.backup.abd.setup.datesOlder')));
    const cutoff = new Date(YEAR - 2, 0, 1);
    expect(screen.getByTestId('abd-cutoff').textContent)
      .toBe(t('settings.backup.abd.setup.datesOlderCutoff', { date: formatDateLong(cutoff) }));
    expect(screen.getByTestId('abd-cutoff').textContent).toContain(String(YEAR - 2));

    await waitFor(() => expect(lastCall().dateChoice).toBe('older_than_2'));
    const scope = lastCall().dates;
    expect(scope).toMatchObject({ kind: 'range', sinceMs: null });
    const before = new Date(scope.beforeMs);
    expect([before.getFullYear(), before.getMonth(), before.getDate(), before.getHours(), before.getMinutes()]).toEqual([YEAR - 2, 0, 1, 0, 0]);
  });

  it('This year and Last year send their scope', async () => {
    ready();
    renderSetup();
    await settled();
    fireEvent.click(radio(t('settings.backup.abd.setup.datesThisYear')));
    await waitFor(() => expect(lastCall().dates).toEqual({ kind: 'range', sinceMs: new Date(YEAR, 0, 1).getTime(), beforeMs: null }));
    fireEvent.click(radio(t('settings.backup.abd.setup.datesLastYear')));
    await waitFor(() => expect(lastCall().dates).toEqual({ kind: 'years', years: [YEAR - 1] }));
  });

  it('Choose years lists every year with its count, oldest first, whatever the other choices', async () => {
    ready();
    renderSetup();
    await settled();
    fireEvent.click(radio(t('settings.backup.abd.setup.datesChoose')));
    const list = within(screen.getByTestId('abd-years'));
    const rows = SUMMARY.years.map(y => t('settings.backup.abd.setup.yearCount', { year: y.year, count: y.count }));
    for (const row of rows) expect(list.getByText(row)).toBeTruthy();
    const order = [...screen.getByTestId('abd-years').querySelectorAll('label')].map(l => l.textContent);
    expect(order).toEqual(rows);

    fireEvent.click(screen.getByTestId('abd-year-2019'));
    fireEvent.click(screen.getByTestId(`abd-year-${YEAR - 1}`));
    await waitFor(() => expect(lastCall().dates).toEqual({ kind: 'years', years: [2019, YEAR - 1] }));
    fireEvent.click(screen.getByTestId('abd-year-2019'));
    await waitFor(() => expect(lastCall().dates).toEqual({ kind: 'years', years: [YEAR - 1] }));
  });

  it('says whose calendar the dates are', async () => {
    ready();
    renderSetup();
    await settled();
    expect(screen.getByText(t('settings.backup.abd.setup.dateBasis'))).toBeTruthy();
  });
});

describe('yearsInScope', () => {
  const years = [2019, YEAR - 3, YEAR - 2, YEAR - 1, YEAR].map(year => ({ year, count: 1, bytes: 1 }));
  const list = (choice, picked) => yearsInScope(choice, years, { picked }).map(y => y.year);

  it('narrows the per-year list to the chosen dates', () => {
    expect(list('all')).toEqual(years.map(y => y.year));
    expect(list('this_year')).toEqual([YEAR]);
    expect(list('last_year')).toEqual([YEAR - 1]);
    // Jan 1 of YEAR-2 is the cut-off: YEAR-2 itself stays on the server.
    expect(list('older_than_2')).toEqual([2019, YEAR - 3]);
    expect(list('years', [2019, YEAR])).toEqual([2019, YEAR]);
  });
});

describe('when and how', () => {
  it('defaults to after everything and Move to Trash, and sends the choice', async () => {
    ready();
    renderSetup();
    await settled();
    expect(radio(t('settings.backup.abd.setup.whenAfterAll')).checked).toBe(true);
    expect(radio(t('settings.backup.abd.setup.howTrash')).checked).toBe(true);
    expect(lastCall().deleteMode).toBe('move_to_trash');

    fireEvent.click(radio(t('settings.backup.abd.setup.howEmpty')));
    await waitFor(() => expect(lastCall().deleteMode).toBe('move_to_trash_and_empty'));
  });

  it('disables "empty it" with its reason when the server can not do it', async () => {
    svc.summarize.mockImplementation(async () => ({ ...SUMMARY, canEmpty: false, warnings: ['cannot_empty'] }));
    ready();
    renderSetup();
    await settled();
    expect(radio(t('settings.backup.abd.setup.howEmpty')).disabled).toBe(true);
    expect(screen.getByText(t('settings.backup.abd.setup.cannotEmpty'))).toBeTruthy();
    expect(radio(t('settings.backup.abd.setup.howTrash')).disabled).toBe(false);
  });
});

describe('summary', () => {
  it('states the total, each ticked folder, the years in scope, what is already saved and what is left to download', async () => {
    ready();
    renderSetup({ mode: 'archive_backup_delete' });
    await settled();
    await waitFor(() => expect(screen.getByTestId('abd-summary-total').textContent)
      .toBe(t('settings.backup.abd.setup.summaryTotal', { count: 1223, size: formatBytes(99_000_000) })));
    expect(screen.getByTestId('abd-summary-folders').textContent).toContain(t('settings.backup.abd.setup.summaryTotal', { count: 1200, size: formatBytes(98_765_432) }));
    expect(screen.getByTestId('abd-summary-years').children).toHaveLength(SUMMARY.years.length);
    expect(screen.getByTestId('abd-summary-archived').textContent).toBe(t('settings.backup.abd.setup.alreadyArchived', { count: '800' }));
    expect(screen.getByTestId('abd-summary-on-drive').textContent).toBe(t('settings.backup.abd.setup.alreadyOnDrive', { count: '700' }));
    expect(screen.getByTestId('abd-summary-download').textContent).toBe(t('settings.backup.abd.setup.toDownload', { size: formatBytes(55_000_000) }));
    expect(screen.getByTestId('abd-summary-estimate').textContent).toBe(t('settings.backup.abd.setup.estimateDays', { count: 2, limit: formatBytes(2_000_000_000) }));
  });

  it('an archive-only job has no backup drive line', async () => {
    ready();
    renderSetup();
    await settled();
    expect(screen.queryByTestId('abd-summary-on-drive')).toBeNull();
  });

  it('counts a multi-label Gmail message once, and warns', async () => {
    svc.summarize.mockImplementation(async () => ({
      ...SUMMARY, provider: 'gmail', warnings: ['multi_label'],
      total: { ...SUMMARY.total, count: 1300, uniqueMessages: 1223 },
    }));
    ready();
    renderSetup();
    await settled();
    await waitFor(() => expect(screen.getByTestId('abd-summary-total').textContent).toContain('1223'));
    expect(screen.getByText(t('settings.backup.abd.setup.multiLabel'))).toBeTruthy();
  });

  it('says when no daily limit applies, and names the Gmail cap when it is the limit', async () => {
    svc.summarize.mockImplementation(async () => ({ ...SUMMARY, estimate: { dailyLimitBytes: null, allowanceLeftBytes: null, days: null, gmailCap: false } }));
    ready();
    const view = renderSetup();
    await settled();
    await waitFor(() => expect(screen.getByTestId('abd-summary-no-limit')).toBeTruthy());
    view.unmount();

    svc.summarize.mockImplementation(async () => ({ ...SUMMARY, estimate: { dailyLimitBytes: null, allowanceLeftBytes: null, days: 4, gmailCap: true } }));
    ready();
    renderSetup();
    await settled();
    await waitFor(() => expect(screen.getByText(t('settings.backup.abd.setup.estimateGmail'))).toBeTruthy());
    expect(screen.getByTestId('abd-summary-estimate').textContent).toContain(formatBytes(2500 * 1024 * 1024));
  });
});

describe('Start', () => {
  const start = () => screen.getByTestId('abd-start');
  const tick = () => fireEvent.click(screen.getByTestId('abd-confirm'));

  it('is off until the "I understand" box is ticked', async () => {
    ready();
    renderSetup();
    await settled();
    expect(start().disabled).toBe(true);
    tick();
    expect(start().disabled).toBe(false);
    tick();
    expect(start().disabled).toBe(true);
  });

  it('is off for a server that can not delete safely, ticked or not, and says so', async () => {
    svc.summarize.mockImplementation(async () => ({ ...SUMMARY, canDelete: false, warnings: ['cannot_delete'] }));
    ready();
    renderSetup();
    await settled();
    await waitFor(() => expect(screen.getByTestId('abd-cannot-delete').textContent).toBe(t('settings.backup.abd.setup.cannotDelete')));
    tick();
    expect(start().disabled).toBe(true);
  });

  it('is off when the selection holds no email', async () => {
    svc.summarize.mockImplementation(async () => ({ ...SUMMARY, total: { count: 0, bytes: 0, uniqueMessages: 0, toDownloadBytes: 0 } }));
    ready();
    renderSetup();
    await settled();
    tick();
    expect(start().disabled).toBe(true);
  });

  it('a change of the selection takes the tick back', async () => {
    ready();
    renderSetup();
    await settled();
    tick();
    expect(screen.getByTestId('abd-confirm').checked).toBe(true);
    fireEvent.click(screen.getByTestId('abd-folder-Trash'));
    expect(screen.getByTestId('abd-confirm').checked).toBe(false);
    expect(start().disabled).toBe(true);
  });

  it('starts the job with the whole selection, confirmed, and hands over to the panel', async () => {
    const onStarted = vi.fn();
    ready();
    renderSetup({ mode: 'archive_backup_delete', onStarted });
    await settled();
    fireEvent.click(radio(t('settings.backup.abd.setup.whenAsSaved')));
    fireEvent.click(radio(t('settings.backup.abd.setup.howEmpty')));
    fireEvent.click(screen.getByTestId('abd-folder-Trash'));
    await waitFor(() => expect(lastCall().deleteMode).toBe('move_to_trash_and_empty'));
    await waitFor(() => expect(lastCall().folders).toEqual(['Archive', 'INBOX']));
    // The summary for this selection has to be back before Start can turn on.
    await fresh();
    tick();
    expect(start().disabled).toBe(false);

    fireEvent.click(start());
    await waitFor(() => expect(svc.startJob).toHaveBeenCalledOnce());
    const params = svc.startJob.mock.calls[0][0];
    expect(params).toMatchObject({
      accountId: ACCOUNT.id, previewId: 'p1', mode: 'archive_backup_delete', timing: 'as_saved',
      deleteMode: 'move_to_trash_and_empty', folders: ['Archive', 'INBOX'], dates: { kind: 'all' }, dateChoice: 'all', confirmed: true,
    });
    expect(params.yearBounds.length).toBeGreaterThan(50);
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  });

  it('shows a refusal, stays on the screen, and offers a new listing when the summary expired', async () => {
    svc.startJob.mockRejectedValueOnce(new Error('E_ABD_PREVIEW_EXPIRED: The summary is out of date. Review it again.'));
    const onStarted = vi.fn();
    ready();
    renderSetup({ onStarted });
    await settled();
    tick();
    fireEvent.click(start());
    const error = await screen.findByTestId('abd-start-error');
    expect(error.textContent).toContain('The summary is out of date');
    expect(onStarted).not.toHaveBeenCalled();

    svc.beginPreview.mockClear();
    fireEvent.click(within(error).getByText(t('common.retry')));
    expect(svc.beginPreview).toHaveBeenCalledWith(ACCOUNT.id);
  });

  it('a refusal that is not an expired summary offers no retry', async () => {
    svc.startJob.mockRejectedValueOnce(new Error('E_ABD_NO_BACKUP_DRIVE: The backup drive is not available.'));
    ready();
    renderSetup({ mode: 'archive_backup_delete' });
    await settled();
    tick();
    fireEvent.click(start());
    const error = await screen.findByTestId('abd-start-error');
    expect(within(error).queryByText(t('common.retry'))).toBeNull();
  });
});
