import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ConfigParser } from '@wdio/config/node';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// The JMAP specs need the mock JMAP server only wdio.jmap.conf.js starts. The
// default conf must never pick them up, and the JMAP conf must pick up
// nothing else.
const jmap = ['jmap-account.test.js', 'jmap-mail.test.js'];
let testDirectory;
beforeAll(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'mailvault-jmap-isolation-'));
  vi.stubEnv('E2E_DATA_DIR', testDirectory);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(testDirectory, { recursive: true, force: true }); });

async function selected(config, suite) {
  const parser = new ConfigParser(resolve(config), suite ? { suite: [suite] } : {});
  await parser.initialize();
  return parser.getSpecs().flat().map(file => basename(file)).sort();
}

it.each([undefined, 'ui-headless', 'connected-ci', 'local-manual'])('keeps the JMAP specs out of the default %s selection', async (suite) => {
  const files = await selected('wdio.conf.js', suite);
  for (const file of jmap) expect(files).not.toContain(file);
});

it.each([undefined, 'jmap'])('selects exactly the JMAP specs through wdio.jmap.conf.js (%s)', async (suite) => {
  expect(await selected('wdio.jmap.conf.js', suite)).toEqual([...jmap].sort());
});

it('keeps the JMAP specs out of the Graph conf', async () => {
  for (const file of jmap) expect(await selected('wdio.graph.conf.js')).not.toContain(file);
});
