import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ConfigParser } from '@wdio/config/node';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// The Graph specs need the Graph mailbox only wdio.graph.conf.js loads. The
// default conf must never pick them up, and the Graph conf must pick up
// nothing else.
const graph = ['graph-folder-keys.test.js', 'graph-folder-keys-adopt.test.js', 'graph-backup-one-dir-per-folder.test.js'];
let testDirectory;
beforeAll(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'mailvault-graph-isolation-'));
  vi.stubEnv('E2E_DATA_DIR', testDirectory);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(testDirectory, { recursive: true, force: true }); });

async function selected(config, suite) {
  const parser = new ConfigParser(resolve(config), suite ? { suite: [suite] } : {});
  await parser.initialize();
  return parser.getSpecs().flat().map(file => basename(file)).sort();
}

it.each([undefined, 'ui-headless', 'connected-ci', 'local-manual'])('keeps the Graph specs out of the default %s selection', async (suite) => {
  const files = await selected('wdio.conf.js', suite);
  for (const file of graph) expect(files).not.toContain(file);
});

it.each([undefined, 'graph'])('selects exactly the Graph specs through wdio.graph.conf.js (%s)', async (suite) => {
  expect(await selected('wdio.graph.conf.js', suite)).toEqual([...graph].sort());
});
