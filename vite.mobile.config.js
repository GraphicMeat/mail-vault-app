import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { readFileSync } from 'node:fs';
import tailwindConfig from './tailwind.config.js';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The desktop components the phone renders (src/components/settings/views, src/components/ui) are
// drawn for Tailwind's preflight. The phone app's own CSS is not, so preflight (tailwind-base.css,
// and only that file) is scoped to elements inside `.mv-shared-ui` (the settings shell) and not
// inside `.mv-legacy` (a phone page not moved onto the shared views yet). `:where()` adds no
// specificity, so each rule weighs what it did on desktop.
const SCOPE = '.mv-shared-ui';
const OWN = ':where(:not(.mv-legacy, .mv-legacy *))';
function scopeSelector(selector) {
  const s = selector.trim();
  if (s === 'html' || s === ':host' || s === 'body') return `:where(${SCOPE})`;
  const at = s.indexOf('::');
  const subject = (at < 0 ? s : s.slice(0, at)) || '*';
  const pseudo = at < 0 ? '' : s.slice(at);
  return `:where(${SCOPE}) ${subject}${OWN}${pseudo}`;
}
function scopePreflight() {
  return {
    postcssPlugin: 'mv-scope-preflight',
    OnceExit(root) {
      if (!root.source?.input?.file?.endsWith('tailwind-base.css')) return;
      root.walkRules((rule) => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        rule.selectors = rule.selectors.map(scopeSelector);
      });
    },
  };
}
scopePreflight.postcss = true;

// The mobile shell's frontend (src-tauri-mobile). Mirrors vite.config.js with the mobile entry
// and its own output dir, so a mobile build never touches the desktop `dist`.
export default defineConfig({
  plugins: [react()],
  css: {
    postcss: {
      plugins: [
        tailwindcss({ ...tailwindConfig, content: [...tailwindConfig.content, './mobile.html'] }),
        scopePreflight(),
        autoprefixer(),
      ],
    },
  },
  // A build constant: '1' only in perf-gate builds (scripts/mobile-run.sh sets MV_PERF_GATE=1 for
  // --features perf-gate). App.jsx loads the scripted viewer probe behind it, so a shipping bundle
  // does not contain the probe at all.
  // `MV_APP_VERSION`: package.json's version, shown in Settings > About.
  define: {
    'import.meta.env.MV_APP_VERSION': JSON.stringify(version),
    'import.meta.env.MV_PERF_GATE': JSON.stringify(process.env.MV_PERF_GATE === '1' ? '1' : '0'),
  },
  root: '.',
  worker: {
    format: 'es'
  },
  build: {
    outDir: 'dist-mobile',
    // Same reason as vite.config.js: the CSP has `font-src 'self'`, so fonts ship as files.
    assetsInlineLimit: file => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
    rollupOptions: {
      input: 'mobile.html'
    }
  },
  server: {
    port: 5174,
    open: '/mobile.html'
  }
});
