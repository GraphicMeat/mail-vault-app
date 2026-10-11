// The JMAP e2e conf: one seeded mock IMAP account plus a JMAP account on the
// mock JMAP server (tests/e2e/mockJmap.js), so the sidebar, the account switch
// and All Inboxes all run multi-account. The shared conf starts the mock and
// hands its origin to the app as MAILVAULT_JMAP_BASE (configureMockJmap).
//
// jmap-account adds the JMAP account through the real AccountModal, so it
// starts with the IMAP account only. jmap-mail starts with the JMAP account
// already seeded (the same shape the modal saves), so it spends its time on
// mail. Runs on the Mac mini: `npm run test:e2e:jmap`. No CI job.
import { config as base, configureMockAccounts, configureMockJmap } from './wdio.conf.js';
import { jmapAccount, jmapScenario, seedJmapAccount } from './tests/e2e/mockJmap.js';

configureMockAccounts([{
  id: '11111111-1111-4111-8111-111111111111',
  email: 'luke@mock.test',
  subjectPrefix: 'Luke message',
  inbox: 12,
}]);
configureMockJmap(jmapScenario());

export const config = {
  ...base,
  exclude: [],
  specs: ['./tests/e2e/jmap-*.test.js'],
  suites: { jmap: ['./tests/e2e/jmap-*.test.js'] },

  // Awaited: the shared hook is async and wipes the data dir (resetAppState),
  // so a seed planted before it settles is deleted before the app launches.
  beforeSession: async function (cfg, caps, specs) {
    await base.beforeSession.call(this, cfg, caps, specs);
    if ((specs || []).some((s) => s.includes('jmap-mail'))) {
      const { origin } = JSON.parse(process.env.E2E_MOCK_JMAP);
      seedJmapAccount(process.env.E2E_DATA_DIR, jmapAccount(origin));
    }
  },
};
