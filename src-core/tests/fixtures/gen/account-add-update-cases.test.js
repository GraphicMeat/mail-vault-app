import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';
it('executes byte-preserved historical add/update originals', () => {
  const output = execFileSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(new URL('./account-add-update-capture.cjs', import.meta.url))], { encoding: 'utf8', env: process.env });
  console.log(output.trim()); expect(output).toContain('27 original cases');
});
