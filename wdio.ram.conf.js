// The memory-measurement conf: two mock accounts, one small INBOX and one
// large, so a footprint reading has a slope instead of a single number. The
// per-header cost is the subtraction; the floor (WKWebView + React + Tauri)
// is not app code and is not reducible by it.
//
// Runs on the Mac mini only, one app instance at a time:
//   npx wdio run wdio.ram.conf.js --spec tests/e2e/ram-footprint.test.js
// Matches no suite glob, so CI never selects it.
import { config as base, configureMockAccounts } from './wdio.conf.js';

const SMALL_INBOX = Number(process.env.RAM_SMALL_INBOX || 50);
const BIG_INBOX = Number(process.env.RAM_BIG_INBOX || 10000);

configureMockAccounts([
  {
    id: '55555555-5555-4555-8555-555555555555',
    email: 'small@mock.test',
    subjectPrefix: 'Small message',
    inbox: SMALL_INBOX,
  },
  {
    // crossFolderThread off for the same reason vader's is: the extra message
    // would make the INBOX total one more than the fixture size the report
    // divides by.
    id: '66666666-6666-4666-8666-666666666666',
    email: 'big@mock.test',
    subjectPrefix: 'Big message',
    inbox: BIG_INBOX,
    crossFolderThread: false,
  },
]);

export const config = {
  ...base,
  exclude: [],
  specs: ['./tests/e2e/ram-footprint.test.js'],
  suites: {},
  // Syncing a five-figure mailbox through the mock outruns the shared 2 min
  // timeout, and a spec that dies mid-measurement reads as a hang.
  mochaOpts: { ...base.mochaOpts, timeout: 45 * 60_000 },
};
