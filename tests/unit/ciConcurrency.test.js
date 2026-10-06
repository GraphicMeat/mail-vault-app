import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Every session pushes to main. A push that cancels the running CI run means
// no main run ever finishes while pushes keep landing. GitHub keeps one run
// going and one pending per group, and a newer push replaces the pending run,
// so queued pushes collapse into a single run on the newest commit.
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
    expect(cancels('push')).toBe(false);
  });

  it('still drops superseded pull request builds', () => {
    expect(cancels('pull_request')).toBe(true);
  });
});
