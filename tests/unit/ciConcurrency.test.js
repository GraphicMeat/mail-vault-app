import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Main runs on a nightly schedule or a manual dispatch. Cancelling a running
// main build would leave it with no finished result, so only PRs cancel.
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const block = workflow.match(/^concurrency:\n((?: {2}.*\n)+)/m)?.[1] ?? '';
const cancel = block.match(/^ {2}cancel-in-progress: (.+)$/m)?.[1]?.trim();

// The two GitHub expression shapes this value may take.
function cancels(eventName) {
  if (cancel === 'true' || cancel === 'false') return cancel === 'true';
  const gate = cancel?.match(/^\$\{\{ github\.event_name == '(\w+)' \}\}$/);
  if (!gate) throw new Error(`unrecognised cancel-in-progress: ${cancel}`);
  return eventName === gate[1];
}

describe('CI concurrency', () => {
  it('queues per ref', () => {
    expect(block).toMatch(/^ {2}group: ci-\$\{\{ github\.ref \}\}$/m);
  });

  it('never cancels a running main build', () => {
    expect(cancels('schedule')).toBe(false);
    expect(cancels('workflow_dispatch')).toBe(false);
  });

  it('has a nightly schedule and no push trigger', () => {
    expect(workflow).toMatch(/^ {2}schedule:\n(?: {4}#.*\n)*? {4}- cron: '\d+ \d+ \* \* \*'/m);
    expect(workflow).not.toMatch(/^ {2}push:/m);
  });

  it('gates every test job on the change check', () => {
    for (const job of ['unit-integration', 'imap-mock', 'render-crate', 'blitz-removable', 'e2e']) {
      const body = workflow.match(new RegExp(`^  ${job}:\\n((?: {4}.*\\n|\\n)+)`, 'm'))?.[1] ?? '';
      expect(body, job).toMatch(/needs\.gate\.outputs\.changed == 'true'/);
    }
  });

  it('still drops superseded pull request builds', () => {
    expect(cancels('pull_request')).toBe(true);
  });
});
