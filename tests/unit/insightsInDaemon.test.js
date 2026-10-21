/**
 * Phase 1 row 23: the Insights aggregation (logical-message identity,
 * direction events, day and week buckets, sender ranking, drill-down keys)
 * is computed by the daemon (`src-daemon/src/handlers/insights_aggregate.rs`
 * over `mailvault_core::insights_model`), not by a web worker over rows the
 * app paged itself. Reads the sources, like learningInDaemon: CI never runs
 * `cargo test -p mailvault-daemon` against the app.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const api = readFileSync('src/services/insightsApi.js', 'utf8');
const session = readFileSync('src/services/insightsSession.js', 'utf8');
const transport = readFileSync('src/services/transport.js', 'utf8');
const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'), transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
const handler = readFileSync('src-daemon/src/handlers/insights_aggregate.rs', 'utf8');
const insightsRouter = readFileSync('src-daemon/src/handlers/insights.rs', 'utf8');
const handlersMod = readFileSync('src-daemon/src/handlers/mod.rs', 'utf8');
const demo = readFileSync('src/demo/backend.js', 'utf8');

const RPCS = [...api.matchAll(/send\('(insights\.[a-z_]+)'/g)].map((m) => m[1]);

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...sourceFiles(path));
    } else if (/\.(js|jsx|mjs)$/.test(name) && !/\.test\.jsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe('the Insights aggregation lives in the daemon', () => {
  it('the app bindings call the five insights RPCs', () => {
    expect(RPCS.sort()).toEqual(['insights.aggregate', 'insights.build', 'insights.messages', 'insights.release', 'insights.status']);
  });

  it('the JS model, its calendar and the worker are gone and nothing imports them', () => {
    for (const file of ['src/utils/insights/model.js', 'src/utils/insights/calendar.js', 'src/workers/insightsWorker.js']) {
      expect(existsSync(file), file).toBe(false);
    }
    const importers = sourceFiles('src').filter((f) =>
      /(from|import\()\s*['"][^'"]*(insights\/model|insights\/calendar|insightsWorker)|new URL\([^)]*insightsWorker/.test(readFileSync(f, 'utf8')));
    expect(importers).toEqual([]);
  });

  it('the session neither pages the snapshot nor spawns a worker', () => {
    expect(session).not.toMatch(/insights_read_page|readInsightsPage|new Worker|postMessage/);
    expect(api).not.toMatch(/insights_read_page|insights_begin_snapshot/);
    expect(session).toContain("'insights-build-progress'");
    expect(handler).toContain('"insights-build-progress"');
  });

  it.each(RPCS)('%s is daemon-owned, routed by handlers/insights_aggregate.rs and stubbed in the demo', (rpc) => {
    expect(owned).toContain(`'${rpc}'`);
    expect(handler).toMatch(new RegExp(`"${rpc.replace('.', '\\.')}"[^=]*=>`));
    expect(demo).toMatch(/method\?\.startsWith\('insights\.'\)/);
  });

  it('the daemon chains the aggregation router behind the snapshot router', () => {
    expect(handlersMod).toMatch(/pub\(crate\) mod insights_aggregate;/);
    expect(insightsRouter).toContain('crate::handlers::insights_aggregate::route(');
  });

  it('the model is a core module whose tests are the parity table of the JS answers', () => {
    const model = readFileSync('src-core/src/insights_model.rs', 'utf8');
    for (const fn of ['pub fn query', 'pub fn messages', 'pub fn finish', 'pub fn calendar_days']) expect(model).toContain(fn);
    expect(model).toContain('fn the_rust_model_answers_what_the_js_model_answered');
    const cases = JSON.parse(readFileSync('src-core/tests/fixtures/insights-model-cases.json', 'utf8'));
    expect(cases.cases.length).toBeGreaterThan(40);
  });

  it('no app source buckets Insights events or ranks their senders', () => {
    const hits = [];
    for (const file of sourceFiles('src')) {
      if (file === join('src', 'demo', 'backend.js')) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/buildInsightsModel|queryInsights|matchingInsightsMessages|calendarCell|localDateKey/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
