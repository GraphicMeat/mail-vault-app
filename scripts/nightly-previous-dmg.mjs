// Prints the DMG file name a Sparkle appcast's enclosure points at, so the
// nightly publish can keep that DMG beside the new one: a Sparkle session that
// found the previous nightly may still download it after the feed moved on.
// Usage: node scripts/nightly-previous-dmg.mjs <appcast.xml>  (prints '' if none)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The enclosure's DMG file name, or '' when the feed has none. */
export function previousDmgName(xml) {
  const url = /<enclosure\b[^>]*\burl="([^"]+)"/.exec(xml ?? '')?.[1] ?? '';
  const name = url.split('/').pop() ?? '';
  return /^[\w.-]+\.dmg$/.test(name) ? name : '';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let xml = '';
  try { xml = readFileSync(process.argv[2], 'utf8'); } catch { /* no previous feed */ }
  console.log(previousDmgName(xml));
}
