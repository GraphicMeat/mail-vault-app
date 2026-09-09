import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ConfigParser } from '@wdio/config/node';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const insights = ['connected-insights.test.js', 'ui-insights.test.js'];
let testDirectory;
beforeAll(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'mailvault-runner-isolation-'));
  vi.stubEnv('E2E_DATA_DIR', testDirectory);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(testDirectory, { recursive: true, force: true }); });

async function selected(config, suite) {
  // Use WDIO's actual glob/suite/exclusion resolver. Initializing configuration
  // does not run its hooks, start the app, or launch the fixture servers.
  const parser = new ConfigParser(resolve(config), suite ? { suite: [suite] } : {});
  await parser.initialize();
  return parser.getSpecs().flat().map(file => basename(file)).sort();
}

it.each([
  [undefined, ['ui-sidebar.test.js', 'connected-accounts.test.js']],
  ['ui-headless', ['ui-sidebar.test.js']],
  ['connected-ci', ['connected-accounts.test.js']],
])('keeps dedicated Insights fixtures out of the default %s selection', async (suite, retained) => {
  const files = await selected('wdio.conf.js', suite);
  expect(files).toEqual(expect.arrayContaining(retained));
  for (const file of insights) expect(files).not.toContain(file);
});

it.each([undefined, 'insights'])('selects both Insights scenarios only through their dedicated %s configuration', async suite => {
  expect(await selected('wdio.insights.conf.js', suite)).toEqual(insights);
});
