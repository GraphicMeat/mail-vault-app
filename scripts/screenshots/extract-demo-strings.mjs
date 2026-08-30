/**
 * Write the English demo catalog — every string the demo mailbox shows a reader.
 *
 *   node scripts/screenshots/extract-demo-strings.mjs > scripts/screenshots/demo/en.json
 *
 * The list comes from what `S()` is actually asked for while the three
 * scenarios build, not from parsing the source: a string assembled at runtime
 * cannot hide from it, and a string nobody renders cannot pad the catalog.
 */
import { collectStrings } from './demoData.js';

const out = {};
for (const s of collectStrings()) out[s] = s;
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
