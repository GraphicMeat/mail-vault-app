#!/usr/bin/env node
// Weekly funnel report: the four numbers to track, read-only, from production.
//
//   node scripts/funnel-report.mjs [--weeks 12] [--exclude-sub 3,9] [--json]
//
// The numbers live on the website host (Meatlytics' analytics.db, the Stripe-fed
// billing_subscriptions table, and the meatlytics module that splits GitHub
// installer fetches into new users vs updates). This file therefore pipes
// itself to that host over ssh and runs `--collect` there: nothing is copied
// to the host, nothing is written, every query is a SELECT. The maths and the
// report run here, on the raw rows it prints.
//
// Stages (MailVault has no account, so "signup" is the download):
//   visitor -> download     unique visitors who clicked a download / unique visitors
//   new user -> subscription  new subscriptions / new users (meatlytics, per release window)
//   trial -> paid           yearly trials that reached a paid invoice / resolved trials
//   first charge failed     trials whose first charge failed / trials that were charged
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DAY = 86_400_000;
const SSH_HOST = 'hetzner-root';
const APP_DIR = '/opt/mailvault-api';
const SITE_ID = 'mailvault';
const GITHUB_REPO = 'GraphicMeat/mail-vault-app';
// The owner's own checkout subscription: a two-year comp, not a customer.
const DEFAULT_EXCLUDE_SUBS = [3];
// The owner browses from here; every analytics read excludes it.
const EXCLUDE_COUNTRY = 'LT';

// ---------- pure: everything below is covered by scripts/__tests__/funnelReport.test.js ----------

/** Monday (UTC) of the week containing `ms`, as YYYY-MM-DD. */
export function weekStart(ms) {
  const back = (new Date(ms).getUTCDay() + 6) % 7;
  return new Date(ms - back * DAY).toISOString().slice(0, 10);
}

/**
 * Where one subscription stands in the yearly 14-day-trial funnel.
 * Stripe keeps created_at at trial start and rolls the period to the paid year
 * (365d, starting +14d) when the trial ends, so the two durations tell the
 * trial from a plain yearly sub. Monthly bills from day one and never trials.
 */
export function classifyTrial(s) {
  const { period_start_ms: start, period_end_ms: end, created_ms: created } = s;
  if (s.price_interval !== 'year' || ![start, end, created].every(Number.isFinite)) return 'no_trial';
  const periodDays = (end - start) / DAY;
  const offsetDays = (start - created) / DAY;
  if (periodDays > 15 && offsetDays < 13) return 'no_trial';
  if (periodDays <= 15) return s.status === 'canceled' ? 'cancelled_in_trial' : 'in_trial';
  return s.latest_invoice_status === 'paid' ? 'paid' : 'charge_failed';
}

/** Trial outcomes and the two rates. Rates are null (not NaN) with nothing to divide. */
export function trialFunnel(subs) {
  const counts = { in_trial: 0, paid: 0, charge_failed: 0, cancelled_in_trial: 0 };
  for (const s of subs) {
    const outcome = classifyTrial(s);
    if (outcome !== 'no_trial') counts[outcome]++;
  }
  const charged = counts.paid + counts.charge_failed;
  const resolved = charged + counts.cancelled_in_trial;
  return {
    counts,
    started: resolved + counts.in_trial,
    resolved,
    charged,
    conversion: resolved ? counts.paid / resolved : null,
    chargeFailure: charged ? counts.charge_failed / charged : null,
  };
}

/**
 * One row per Monday, oldest first. Releases are attributed to the week they
 * were published (a release window can span weeks: read it as a trend); releases
 * with no site count predate tracking and are left out.
 */
export function mergeWeeks({ visitors = {}, downloaders = {}, releases = [], subs = [] }) {
  const rows = new Map();
  const row = (week) => {
    if (!rows.has(week)) rows.set(week, { week, visitors: 0, downloaders: 0, newUsers: 0, updates: 0, newSubs: 0 });
    return rows.get(week);
  };
  for (const [w, n] of Object.entries(visitors)) row(w).visitors = n;
  for (const [w, n] of Object.entries(downloaders)) row(w).downloaders = n;
  for (const r of releases) {
    if (r.newUsers === null || r.newUsers === undefined) continue;
    const target = row(weekStart(Date.parse(r.published)));
    target.newUsers += r.newUsers;
    target.updates += r.updates;
  }
  for (const s of subs) row(weekStart(s.created_ms)).newSubs++;
  return [...rows.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((r) => ({ ...r, visitorToDownload: r.visitors ? r.downloaders / r.visitors : null }));
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function renderReport({ weeks, trial, generatedAt }) {
  const sum = (k) => weeks.reduce((a, w) => a + w[k], 0);
  const visitors = sum('visitors');
  // Billing began mid-window: new users from before the first subscription could
  // not have subscribed, and would only dilute the rate.
  const firstSubWeek = weeks.find((w) => w.newSubs > 0)?.week;
  const billable = firstSubWeek ? weeks.filter((w) => w.week >= firstSubWeek) : [];
  const newUsers = billable.reduce((a, w) => a + w.newUsers, 0);
  const subs = billable.reduce((a, w) => a + w.newSubs, 0);
  const out = [`MailVault funnel, ${generatedAt}`, ''];

  out.push('stage                      window', '-------------------------  ------------------------------');
  out.push(`visitor -> download        ${pct(visitors ? sum('downloaders') / visitors : null)}  (${sum('downloaders')} of ${visitors} unique visitors, summed per week)`);
  out.push(`new user -> subscription   ${pct(newUsers ? subs / newUsers : null)}  (${subs} subs of ${newUsers} new users, from the first subscription week)`);
  out.push(`trial -> paid              ${pct(trial.conversion)}  (${trial.counts.paid} of ${trial.resolved} resolved trials, all time)`);
  out.push(`first charge failed        ${pct(trial.chargeFailure)}  (${trial.counts.charge_failed} of ${trial.charged} charged, all time)`);
  out.push('', `trials: ${trial.started} started, ${trial.counts.in_trial} in trial, ${trial.counts.paid} paid, ` +
    `${trial.counts.charge_failed} charge failed, ${trial.counts.cancelled_in_trial} cancelled in trial`);

  out.push('', 'week        visitors  downloaders  v->dl   new users  updates  new subs');
  for (const w of weeks) {
    out.push(
      `${w.week}  ${String(w.visitors).padStart(8)}  ${String(w.downloaders).padStart(11)}  ` +
      `${pct(w.visitorToDownload).padStart(5)}  ${String(w.newUsers).padStart(9)}  ${String(w.updates).padStart(7)}  ${String(w.newSubs).padStart(8)}`
    );
  }
  out.push('', 'new users / updates: meatlytics GitHub split, by release week. A trend, not a census.');
  return out.join('\n');
}

// ---------- on the host: read-only collection ----------

function mysqlRows(sql) {
  const r = spawnSync('mysql', ['-B', '-N', '-e', sql, 'mailvault_website'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`mysql: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
}

const num = (v) => (v === 'NULL' || v === undefined ? null : Number(v));

async function collect({ weeks, excludeSubs }) {
  const require = createRequire(`${process.cwd()}/`);
  const Database = require('better-sqlite3');
  const { createReleases, split, normalize } = require('meatlytics/src/github');
  const db = new Database('analytics.db', { readonly: true });
  const since = Date.now() - weeks * 7 * DAY;

  const weekly = (type) => Object.fromEntries(db.prepare(
    `select date(ts/1000,'unixepoch','weekday 0','-6 days') wk, count(distinct visitor) n
       from events where site_id = ? and type = ? and coalesce(country,'') <> ? and ts >= ? group by 1`
  ).all(SITE_ID, type, EXCLUDE_COUNTRY, since).map((r) => [r.wk, r.n]));

  const app = normalize(GITHUB_REPO)[0];
  const releases = split(db, SITE_ID, [EXCLUDE_COUNTRY], app, await createReleases()(app.repo)).releases
    .filter((r) => Date.parse(r.published) >= since)
    .map(({ tag, published, gh, site, newUsers, updates }) => ({ tag, published, gh, site, newUsers, updates }));

  const ids = excludeSubs.length ? excludeSubs.join(',') : '0'; // ints only, validated by parseArgs
  const subs = mysqlRows(
    `select id, price_interval, status, UNIX_TIMESTAMP(created_at)*1000, UNIX_TIMESTAMP(current_period_start)*1000,
            UNIX_TIMESTAMP(current_period_end)*1000, cancel_at_period_end, latest_invoice_status
       from billing_subscriptions where id not in (${ids})`
  ).map(([id, price_interval, status, created, start, end, cancel, invoice]) => ({
    id: Number(id), price_interval, status,
    created_ms: num(created), period_start_ms: num(start), period_end_ms: num(end),
    cancel_at_period_end: Number(cancel), latest_invoice_status: invoice === 'NULL' ? null : invoice,
  }));

  process.stdout.write(JSON.stringify({ visitors: weekly('pageview'), downloaders: weekly('download'), releases, subs }));
}

// ---------- here: ssh, then report ----------

function parseArgs(argv) {
  const opts = { weeks: 12, excludeSubs: DEFAULT_EXCLUDE_SUBS, json: false, collect: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--collect') opts.collect = true;
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--weeks') opts.weeks = Number(argv[++i]);
    else if (argv[i] === '--exclude-sub') opts.excludeSubs = String(argv[++i]).split(',').filter(Boolean).map(Number);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(opts.weeks) || opts.weeks < 1) throw new Error('--weeks needs a positive integer');
  if (!opts.excludeSubs.every(Number.isInteger)) throw new Error('--exclude-sub needs a comma-separated list of integers');
  return opts;
}

function fetchFromHost({ weeks, excludeSubs }) {
  // Only validated integers reach the remote command line.
  const cmd = `cd ${APP_DIR} && node --input-type=module - --collect --weeks ${weeks} --exclude-sub ${excludeSubs.join(',')}`;
  const r = spawnSync('ssh', [SSH_HOST, cmd], {
    input: readFileSync(fileURLToPath(import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ssh ${SSH_HOST}: ${r.stderr.trim() || `exit ${r.status}`}`);
  return JSON.parse(r.stdout);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.collect) return collect(opts);
  const raw = fetchFromHost(opts);
  if (opts.json) return console.log(JSON.stringify(raw, null, 2));
  console.log(renderReport({
    weeks: mergeWeeks(raw),
    trial: trialFunnel(raw.subs),
    generatedAt: new Date().toISOString().slice(0, 10),
  }));
}

// `--collect` runs from stdin on the host, where argv[1] is not this file.
if (process.argv.includes('--collect') || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
