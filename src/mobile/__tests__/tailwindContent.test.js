// @vitest-environment node
// The phone's Tailwind reads only what the phone renders (src/mobile/tailwindContent.js). Every
// script module the phone bundle reaches (src/mobile/seam.js, from main.jsx) must be inside it, or
// its classes would be missing from the phone's CSS without any error.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { analyzeSeam } from '../seam.js';
import { MOBILE_TAILWIND_CONTENT } from '../tailwindContent.js';

const ENTRY = fileURLToPath(new URL('../main.jsx', import.meta.url));
const covered = picomatch(MOBILE_TAILWIND_CONTENT.map((glob) => glob.replace(/^\.\//, '')));

describe('phone Tailwind content', () => {
  it('covers every script module the phone bundle reaches', async () => {
    const { modules } = await analyzeSeam(ENTRY);
    const scripts = modules.filter((m) => !m.includes('node_modules/') && /\.(js|jsx|ts|tsx)$/.test(m));
    expect(scripts.length).toBeGreaterThan(100);
    expect(scripts.filter((m) => !covered(m))).toEqual([]);
  });

  it('is narrower than all of src', () => {
    expect(covered('src/components/Sidebar.jsx')).toBe(false);
    expect(covered('src/components/settings/AccountSettings.jsx')).toBe(false);
    expect(covered('src/mobile/Settings.jsx')).toBe(true);
  });
});

describe("the phone's Tailwind config", () => {
  // iOS keeps :hover on whatever was tapped last, so a desktop Button's hover: fill stuck after a
  // tap. The phone's Tailwind wraps hover: in @media (hover: hover); desktop's stays as it was.
  it('applies hover only where the pointer can hover, for the phone bundle alone', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
    const phone = read('../../../vite.mobile.config.js');
    expect(phone).toMatch(/tailwindcss\(\{\s*\.\.\.tailwindConfig,[^)]*future:\s*\{\s*\.\.\.tailwindConfig\.future,\s*hoverOnlyWhenSupported:\s*true\s*\}/);
    expect(read('../../../tailwind.config.js')).not.toMatch(/hoverOnlyWhenSupported/);
  });
});
