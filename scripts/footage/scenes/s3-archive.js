/**
 * S3 "Clear the server. Keep everything." - its own boot, because it deletes
 * a year from the mock server.
 *
 * The inbox at rest; Select messages; the bulk dialog lists the years; one year
 * is picked; Next; Archive & delete; the confirmation; Start. The dialog folds
 * into the progress bubble, which runs "Downloading" (the vault copies) and then
 * "Deleting", and lands on "Operation Complete".
 *
 * The progress speed is the mock server's body-fetch stall
 * (FOOTAGE_BODY_DELAY_MS, applied to every `BODY.PEEK[]`), sized so the bar is
 * readable for several seconds. Every progress frame the bubble shows during
 * the take is logged to s3-archive.progress.json with its video time, which is
 * what the next calibration reads.
 *
 * FOOTAGE_S3_YEAR (default: the oldest year the dialog offers).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, sampleLoad, pointer, OUT_DIR } from '../lib/footage.js';
import { L, probe, bootToInbox, resetView, beforeTake, waitPage, since } from '../lib/scene.js';

const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const SELECT = `.mail-list-toolbar button[aria-label="${L('workspace.selectMessages')}"]`;

const bubbleText = () => {
  for (const el of document.querySelectorAll('.fixed.bottom-4.right-4')) {
    if (el.offsetHeight > 0) return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }
  return '';
};

describe('footage: s3-archive', function () {
  this.timeout(1200000);
  const facts = {};

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    await resetView();
  });

  after(function () {
    writeFileSync(join(OUT_DIR, 's3-archive.facts.json'), JSON.stringify(facts, null, 2));
  });

  it('s3-archive', async function () {
    await beforeTake('s3-archive');
    const take = new Take('s3-archive');
    await take.start();
    const load = sampleLoad('s3-archive', 3);
    await take.hold(900);
    await take.click(SELECT, 'select-messages');
    await take.waitFor((t) => document.body.innerText.includes(t), 'bulk dialog', 10000, L('bulk.ops.bulkEmailOperations'));
    // The year buttons come from the whole header cache, read when the dialog
    // opens; until that read lands they describe the loaded window only.
    const reading = L('bulk.ops.readingAllEmails').split('{{')[0].trim();
    await take.waitFor((r) => !document.body.innerText.includes(r) && [...document.querySelectorAll('[role="dialog"] button')]
      .filter((b) => /^\d{4} \(/.test((b.textContent || '').trim())).length >= 2, 'year buttons', 30000, reading);
    facts.years = await browser.execute(() => [...document.querySelectorAll('[role="dialog"] button')]
      .map((b) => (b.textContent || '').trim()).filter((s) => /^\d{4} \(/.test(s)));
    const year = process.env.FOOTAGE_S3_YEAR || facts.years.map((s) => s.slice(0, 4)).sort()[0];
    await take.hold(1100);
    await take.click('[role="dialog"] button', `year-${year}`, { text: `${year} (` });
    const selectedWord = L('bulk.ops.emailsSelected').replace('{{selectedCount}}', '').trim();
    await take.waitFor((w) => document.body.innerText.includes(w), 'selection count', 10000, selectedWord);
    facts.selected = await browser.execute((w) => document.body.innerText.match(new RegExp(`([\\d,]+) ${w}`))?.[1], selectedWord);
    await take.hold(1100);
    await take.waitFor((n) => [...document.querySelectorAll('[role="dialog"] button')]
      .some((b) => (b.textContent || '').trim().startsWith(n) && !b.disabled), 'Next enabled', 15000, L('common.next'));
    await take.click('[role="dialog"] button', 'next', { text: L('common.next') });
    await take.waitFor(() => !!document.querySelector('[data-testid="bulk-action-archive_and_delete"]'), 'actions', 8000);
    await take.hold(800);
    await take.click('[data-testid="bulk-action-archive_and_delete"]', 'archive-and-delete');
    await take.hold(900);
    await take.click('[data-testid="bulk-step2-confirm"]', 'start');
    await take.waitFor(() => !!document.querySelector('[data-testid="bulk-delete-confirm"]'), 'confirmation', 8000);
    await take.hold(1200);
    await take.click('[data-testid="bulk-delete-confirm"]', 'confirm');
    // The run, sampled every 200 ms against video time.
    const progress = [];
    const done = L('bulk.progress.operationComplete');
    const deadline = Date.now() + 240000;
    let finished = false;
    while (Date.now() < deadline) {
      const text = await browser.execute(bubbleText);
      const t = take.t(Date.now());
      if (!progress.length || progress.at(-1).text !== text) progress.push({ t: Number(t.toFixed(3)), text });
      if (text.includes(done)) { finished = true; break; }
      await browser.pause(200);
    }
    facts.progress = progress;
    writeFileSync(join(OUT_DIR, 's3-archive.progress.json'), JSON.stringify(progress, null, 2));
    if (!finished) throw new Error(`archive never completed: ${progress.at(-1)?.text}`);
    const first = progress.find((p) => /\d+%/.test(p.text));
    const last = progress.at(-1);
    facts.progressSeconds = first ? Number((last.t - first.t).toFixed(2)) : null;
    take.note('progress', { firstShown: first?.t ?? null, complete: last.t, seconds: facts.progressSeconds });
    console.log(`[footage] s3 progress visible for ${facts.progressSeconds} s, ${progress.length} distinct frames`);
    // The success state holds until the bubble dismisses itself (4 s).
    await take.hold(2600);
    const rec = await take.stop();
    console.log(`[footage] s3-archive: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
    await load();
    await browser.pause(3000);
    facts.after = await probe();
    if (rec.delivered < 10) throw new Error(`only ${rec.delivered} pictures delivered`);
  });
});
