// The Graph e2e conf: one seeded Outlook account against the loopback Graph
// mock the shared conf already starts (tests/e2e/mockGraph.js). This conf seeds
// the account, loads the German-named mailbox into the mock before the first
// app launch, and plants the adopt spec's legacy directories. Runs on the Mac
// mini (`wdio run wdio.graph.conf.js --spec <spec>`); no CI job yet.
import { config as base, configureMockAccounts } from './wdio.conf.js';
import { graphAccount, graphScenarioFolders, seedLegacyGraphDirs, GRAPH_ACCOUNT_ID } from './tests/e2e/mockGraph.js';

configureMockAccounts([{ graph: true, account: graphAccount(), email: graphAccount().email }]);

export const config = {
  ...base,
  exclude: [],
  specs: ['./tests/e2e/graph-*.test.js'],
  suites: { graph: ['./tests/e2e/graph-*.test.js'] },

  onPrepare: async function (...args) {
    await base.onPrepare.apply(this, args);
    // The shared hook started the mock and exported its origin; the app has not
    // launched yet (that happens per session), so the mailbox goes in now.
    const { origin } = JSON.parse(process.env.E2E_MOCK_GRAPH);
    const r = await fetch(`${origin}/__mock/folders`, { method: 'PUT', body: JSON.stringify(graphScenarioFolders()) });
    if (!r.ok) throw new Error(`mock Graph PUT /__mock/folders failed: ${r.status}`);
    console.log(`[wdio.graph] German mailbox loaded into the mock at ${origin}`);
  },

  beforeSession: function (cfg, caps, specs) {
    base.beforeSession.call(this, cfg, caps, specs);
    if ((specs || []).some((s) => s.includes('graph-folder-keys-adopt'))) {
      seedLegacyGraphDirs(process.env.E2E_DATA_DIR, GRAPH_ACCOUNT_ID);
    }
  },
};
