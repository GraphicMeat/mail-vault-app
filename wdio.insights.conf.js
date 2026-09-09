import { config as base, configureMockAccounts } from './wdio.conf.js';
import { buildInsightsScenario } from './tests/e2e/insightsFixture.js';

const inboxCount = process.env.E2E_INSIGHTS_LARGE === '1' ? 50000 : 700;
configureMockAccounts(buildInsightsScenario({ inboxCount }).accounts);

export const config = {
  ...base,
  exclude: [],
  specs: ['./tests/e2e/connected-insights.test.js', './tests/e2e/ui-insights.test.js'],
  suites: { insights: ['./tests/e2e/connected-insights.test.js', './tests/e2e/ui-insights.test.js'] },
  mochaOpts: { ...base.mochaOpts, timeout: 180000 },
};
