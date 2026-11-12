/**
 * One definition per small helper. `listenTo` lives only in
 * src/services/listenTo.js. `formatDuration` has four copies that format
 * different units and words; each is listed below with the reason it is not
 * merged. A new definition anywhere else fails here: share it or add it to the
 * list with the reason it must differ.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = {
  listenTo: {
    'src/services/listenTo.js': 'the shared module',
  },
  formatDuration: {
    'src/components/SearchBar.jsx': 'milliseconds to "294 ms" / "8.52 s", search.* catalog keys, 2-digit seconds',
    'src/components/settings/NetworkActivity.jsx': 'milliseconds through Intl unit style, narrow, one decimal',
    'src/components/settings/BackupAccountCard.jsx': 'seconds to "12s" / "3m 5s", settings.backup.account.* keys',
    'src/components/settings/MigrationSettings.jsx': 'seconds to "< 1 min" / "2h 5m", settings.migration.* keys',
  },
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') walk(p, out);
    } else if (/\.(js|jsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const definesRe = (name) => new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=)`);

describe('shared small helpers', () => {
  const files = walk('src');
  for (const name of Object.keys(ALLOWED)) {
    it(`${name} is defined only where the list allows`, () => {
      const re = definesRe(name);
      const found = files.filter((f) => re.test(readFileSync(f, 'utf8'))).sort();
      expect(found).toEqual(Object.keys(ALLOWED[name]).sort());
    });
  }
});
