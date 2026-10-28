import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('captures the exact pre-port sync probe and folder status exports', () => {
  const capture = fileURLToPath(new URL('./sync-observation-capture.cjs', import.meta.url));
  const output = execFileSync(process.execPath, ['--experimental-vm-modules', capture], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  expect(output).toMatch(/Captured\/verified [1-9]\d* probe cases and [1-9]\d* folder cases [a-f0-9]{64}\n/);
});
