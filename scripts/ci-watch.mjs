#!/usr/bin/env node
// Watch the CI run that covers a commit on main:
//   node scripts/ci-watch.mjs [sha]   (default HEAD)
// Main is tested by the nightly schedule or a manual dispatch
// (`gh workflow run ci.yml --ref main`, `-f force=true` skips the change
// gate), not per push. The run that covers a commit is the oldest one, not
// cancelled, whose head contains it. Exits with that run's result.
import { execFileSync, spawnSync } from 'node:child_process';

const GIVE_UP_MS = 5 * 60 * 1000;

export function coveringRun(runs, contains) {
  return [...runs]
    .filter((run) => run.conclusion !== 'cancelled')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .find((run) => contains(run.headSha)) ?? null;
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const isAncestor = (sha, head) =>
  spawnSync('git', ['merge-base', '--is-ancestor', sha, head]).status === 0;

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const sha = sh('git', ['rev-parse', process.argv[2] ?? 'HEAD']);
  let started = Date.now();
  for (;;) {
    sh('git', ['fetch', '-q', 'origin', 'main']);
    const runs = JSON.parse(sh('gh', ['run', 'list', '--workflow', 'ci.yml', '--branch', 'main',
      '--limit', '50', '--json', 'databaseId,headSha,createdAt,status,conclusion,event']))
      .filter((r) => r.event !== 'pull_request');
    const run = coveringRun(runs, (head) => isAncestor(sha, head));
    if (!run) {
      if (Date.now() - started > GIVE_UP_MS) {
        console.error(`ci-watch: no CI run covers ${sha.slice(0, 9)}; main is tested nightly: dispatch one with gh workflow run ci.yml --ref main`);
        process.exit(2);
      }
      spawnSync('sleep', ['20']);
      continue;
    }
    console.error(`ci-watch: ${sha.slice(0, 9)} covered by run ${run.databaseId} on ${run.headSha.slice(0, 9)}`);
    const watched = spawnSync('gh', ['run', 'watch', String(run.databaseId), '--exit-status', '--interval', '30'],
      { stdio: 'inherit' });
    const { conclusion } = JSON.parse(sh('gh', ['run', 'view', String(run.databaseId), '--json', 'conclusion']));
    if (conclusion !== 'cancelled') process.exit(watched.status ?? 1);
    started = Date.now();
  }
}
