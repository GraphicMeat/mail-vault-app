/**
 * Pins what the JS learning logic (learningService.js, ruleExporter.js) does
 * today, so its port to src-core/src/learning.rs can be checked against the
 * same table. The daemon mock stores feedback the way `learning.load` and
 * `learning.save` round-trip it: `learning::Feedback` keeps `rules` and
 * `corrections` as raw JSON and `stats` as three snake_case fields, so the
 * camelCase stats the JS writes never persist.
 *
 * LEARNING_FIXTURE_PRINT=1 prints the table with every expected value filled
 * in (between the LEARNING-FIXTURE markers) instead of asserting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fixture from '../../../src-core/tests/fixtures/learning-cases.json';

const store = new Map();
let saves = 0;

const roundTrip = (v) => JSON.parse(JSON.stringify(v));

// What the daemon's serde does to a saved feedback object.
function asDaemonStores(feedback) {
  const f = roundTrip(feedback);
  if (!Array.isArray(f.rules) || !Array.isArray(f.corrections) || !f.stats || typeof f.stats !== 'object') {
    throw new Error('Missing or invalid feedback');
  }
  return {
    rules: f.rules,
    corrections: f.corrections,
    stats: {
      total_classified: f.stats.total_classified ?? 0,
      total_corrected: f.stats.total_corrected ?? 0,
      accuracy_rate: f.stats.accuracy_rate ?? 0,
    },
  };
}

const emptyFeedback = () => ({ rules: [], corrections: [], stats: { total_classified: 0, total_corrected: 0, accuracy_rate: 0 } });

vi.mock('../daemonClient.js', () => ({
  daemonCall: vi.fn(async (method, params) => {
    if (method === 'learning.load') return roundTrip(store.get(params.accountId) || emptyFeedback());
    if (method === 'learning.save') {
      store.set(params.accountId, asDaemonStores(params.feedback));
      saves += 1;
      return { saved: true };
    }
    throw new Error(`unexpected daemon method ${method}`);
  }),
}));

vi.mock('../../i18n/index.js', () => ({
  t: (key, params) => ({ key, params: params ?? null }),
}));

const learning = await import('../learningService.js');
const exporter = await import('../ruleExporter.js');
const { daemonCall } = await import('../daemonClient.js');

const ACCOUNT = 'acc-1';

async function runStep(step) {
  if (step.now !== undefined) vi.setSystemTime(step.now);
  switch (step.op) {
    case 'recordCorrection': return learning.recordCorrection(ACCOUNT, step.email, step.correction);
    case 'getRules': return learning.getRules(ACCOUNT);
    case 'getStats': return learning.getStats(ACCOUNT);
    case 'saveRule': return learning.saveRule(ACCOUNT, step.rule);
    case 'deleteRule': return learning.deleteRule(ACCOUNT, step.ruleId);
    case 'exportRules': {
      const payload = await exporter.exportRules(ACCOUNT);
      // AISettings writes exactly this text to the downloaded file.
      return { payload, json: JSON.stringify(payload, null, 2) };
    }
    case 'importRules': {
      const imported = await exporter.importRules(ACCOUNT, step.rules,
        (aid) => daemonCall('learning.load', { accountId: aid }),
        (aid, feedback) => daemonCall('learning.save', { accountId: aid, feedback }));
      return { imported };
    }
    default: throw new Error(`unknown op ${step.op}`);
  }
}

async function runScenario(scenario) {
  store.clear();
  if (scenario.initial) store.set(ACCOUNT, roundTrip(scenario.initial));
  const out = [];
  for (const step of scenario.steps) {
    saves = 0;
    const result = await runStep(step);
    const { expect: _e, after: _a, saved: _s, ...input } = step;
    out.push({
      ...input,
      expect: result === undefined ? null : roundTrip(result),
      saved: saves > 0,
      after: roundTrip(store.get(ACCOUNT) || emptyFeedback()),
    });
  }
  return out;
}

const PRINT = process.env.LEARNING_FIXTURE_PRINT === '1';

describe('learning logic (characterization, shared fixture)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  if (PRINT) {
    it('prints the filled-in fixture', async () => {
      const filled = { ...fixture, scenarios: [], previewCases: [] };
      for (const s of fixture.scenarios) filled.scenarios.push({ ...s, steps: await runScenario(s) });
      for (const c of fixture.previewCases) {
        const { expect: _e, ...input } = c;
        filled.previewCases.push({ ...input, expect: roundTrip(exporter.previewImport(c.text)) });
      }
      console.log(`LEARNING-FIXTURE-BEGIN${JSON.stringify(filled)}LEARNING-FIXTURE-END`);
    });
    return;
  }

  for (const scenario of fixture.scenarios) {
    it(scenario.name, async () => {
      const steps = await runScenario(scenario);
      steps.forEach((step, i) => {
        const want = scenario.steps[i];
        expect({ op: step.op, i, expect: step.expect, saved: step.saved, after: step.after })
          .toEqual({ op: want.op, i, expect: want.expect, saved: want.saved, after: want.after });
      });
    });
  }

  for (const c of fixture.previewCases) {
    it(`previewImport: ${c.name}`, () => {
      expect(roundTrip(exporter.previewImport(c.text))).toEqual(c.expect);
    });
  }
});
