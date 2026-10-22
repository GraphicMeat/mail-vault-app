/**
 * Phase 1, row 10: tracking pixels, link safety and the alerts a list row
 * wears are the daemon's (`body.scan`, `body.verdicts`, `body.classify_links`,
 * `body.info`; src-daemon/src/handlers/body.rs, rules and the bundled tracker
 * table in src-core/src/body_scan, held to the deleted JS by the golden corpus
 * src-core/tests/fixtures/body-scan-cases.json). The app frames the answer and
 * records the verdicts in its settings store; it decides none of it. CI never
 * runs `cargo test -p mailvault-daemon`, so this reads the sources, same
 * pattern as `senderCheckInDaemon`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { listSourceFiles } from '../../scripts/lib/sourceFiles.mjs';

const read = (path) => readFileSync(path, 'utf8');
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const METHODS = ['body.scan', 'body.verdicts', 'body.classify_links', 'body.info'];

describe('the body scan lives in the daemon', () => {
  it('the JS ports are gone', () => {
    for (const gone of ['src/utils/trackerList.js', 'src/utils/trackerDetect.js', 'src/utils/linkSafety.js',
      'src/utils/replyToCheck.js', 'src/services/trackerVerdicts.js', 'src/stores/slices/rowAlerts.js']) {
      expect(existsSync(gone), gone).toBe(false);
    }
  });

  it.each(METHODS)('the daemon routes %s from its own handler file', (method) => {
    expect(read('src-daemon/src/handlers/body.rs')).toContain(`"${method}"`);
  });

  it('the handler is declared and in the route chain, its rules in src-core', () => {
    expect(read('src-daemon/src/handlers/mod.rs')).toMatch(/pub\(crate\) mod body;/);
    expect(code(read('src-daemon/src/server.rs'))).toMatch(/crate::handlers::body::route\(/);
    expect(read('src-core/src/lib.rs')).toMatch(/pub mod body_scan;/);
    expect(existsSync('src-core/tests/fixtures/body-scan-cases.json')).toBe(true);
  });

  it.each(METHODS)('the app reaches %s as a daemon-owned command, and the browser demo answers it', (method) => {
    expect(read('src/services/transport.js')).toContain(`'${method}'`);
    expect(read('src/demo/backend.js')).toContain(`'${method}'`);
  });

  it('no app source parses a body for trackers or links, or judges a sender, itself', () => {
    const files = listSourceFiles(['src'], ['.js', '.jsx'], { exclude: ['__tests__', '__mocks__', '.test.', '.spec.', 'src/demo/'] });
    const offenders = files.filter((f) => {
      const src = code(read(f));
      return /scanTrackers|scanEmailLinks|classifyLink\(|TRACKER_PATTERNS|SHORTENER_ALLOWLIST|SPACER_ALLOWLIST|BEACON_PATH|detectReplyToMismatch|\bframeBody\(/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('the renderers and the lists ask the daemon', () => {
    expect(code(read('src/services/bodyScan.js'))).toContain("'body.scan'");
    expect(code(read('src/services/bodyScan.js'))).toContain("'body.classify_links'");
    expect(code(read('src/services/rowVerdicts.js'))).toContain("'body.verdicts'");
    for (const f of ['src/components/EmailViewer.jsx', 'src/components/email/ThreadView.jsx', 'src/components/ChatBubbleView.jsx',
      'src/components/email/FullViewEmailModal.jsx', 'src/components/OriginalFrame.jsx', 'src/components/email/EmailPreviewFrame.jsx']) {
      expect(code(read(f)), f).toMatch(/useBodyScan\(/);
    }
    expect(code(read('src/stores/slices/messageListSlice.js'))).toMatch(/from '..\/..\/services\/rowVerdicts'/);
    expect(code(read('src/stores/searchRows.js'))).toMatch(/from '..\/services\/rowVerdicts'/);
  });

  it('the daemon reads the persisted verdicts through the settings document, never the file', () => {
    const handler = read('src-daemon/src/handlers/body.rs');
    expect(handler).toContain('SettingsDoc::shared(');
    expect(handler.slice(0, handler.indexOf('#[cfg(test)]'))).not.toContain('frontend-settings');
  });
});
