#!/usr/bin/env node
/**
 * Generates website/changelog.html from CHANGELOG.md
 * Run: node scripts/generate-changelog.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHANGELOG_MD = path.join(ROOT, 'CHANGELOG.md');
const CHANGELOG_HTML = path.join(ROOT, 'website', 'changelog.html');

// Section type → color scheme + icon SVG
const SECTION_STYLES = {
  Added: {
    color: 'green',
    icon: '<svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>'
  },
  Changed: {
    color: 'blue',
    icon: '<svg class="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>'
  },
  Fixed: {
    color: 'amber',
    icon: '<svg class="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>'
  },
  Removed: {
    color: 'slate',
    icon: '<svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"/></svg>'
  },
  Security: {
    color: 'red',
    icon: '<svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>'
  }
};

function parseChangelog(md) {
  const versions = [];
  let currentVersion = null;
  let currentSection = null;

  for (const line of md.split('\n')) {
    // Version header: ## [1.2.0] - 2026-02-18
    const versionMatch = line.match(/^## \[(.+?)\]\s*-\s*(.+)$/);
    if (versionMatch) {
      currentVersion = { version: versionMatch[1], date: versionMatch[2].trim(), sections: [] };
      versions.push(currentVersion);
      currentSection = null;
      continue;
    }

    // Section header: ### Added
    const sectionMatch = line.match(/^### (.+)$/);
    if (sectionMatch && currentVersion) {
      currentSection = { name: sectionMatch[1].trim(), items: [] };
      currentVersion.sections.push(currentSection);
      continue;
    }

    // List item: - Some change
    const itemMatch = line.match(/^- (.+)$/);
    if (itemMatch && currentSection) {
      // Convert markdown inline code and links to HTML
      let text = itemMatch[1]
        .replace(/`([^`]+)`/g, '<code class="text-slate-500 dark:text-slate-300">$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-primary-500 hover:underline">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      currentSection.items.push(text);
    }
  }

  return versions;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderSection(section) {
  const style = SECTION_STYLES[section.name] || SECTION_STYLES.Changed;
  const color = style.color;

  let html = `        <div class="mb-8">
          <h3 class="flex items-center gap-2 text-lg font-semibold mb-4">
            <span class="w-7 h-7 rounded-lg bg-${color}-100 dark:bg-${color}-900/30 flex items-center justify-center flex-shrink-0">
              ${style.icon}
            </span>
            ${section.name}
          </h3>
          <ul class="space-y-3 text-slate-600 dark:text-slate-400">\n`;

  for (const item of section.items) {
    html += `            <li class="flex items-start gap-3">
              <span class="w-1.5 h-1.5 rounded-full bg-${color}-500 flex-shrink-0 mt-2"></span>
              ${item}
            </li>\n`;
  }

  html += `          </ul>
        </div>\n`;

  return html;
}

function renderVersion(version, isLatest) {
  const formattedDate = formatDate(version.date);
  const latestBadge = isLatest
    ? '\n          <span class="inline-flex items-center px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-medium">Latest</span>'
    : '';

  let html = `      <article class="mb-16">
        <div class="flex items-center gap-3 mb-6">
          <span class="inline-flex items-center px-3 py-1 rounded-full gradient-bg text-white text-sm font-semibold">v${version.version}</span>
          <span class="text-slate-500 dark:text-slate-400 text-sm">${formattedDate}</span>${latestBadge}
        </div>

`;

  for (const section of version.sections) {
    html += renderSection(section);
    html += '\n';
  }

  html += `      </article>\n`;
  return html;
}

function generateHTML(versions) {
  let articles = '';
  versions.forEach((v, i) => {
    articles += renderVersion(v, i === 0);
  });

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Changelog - MailVault | What's New</title>
  <meta name="description" content="See what's new in MailVault. Full changelog of features, improvements, and bug fixes for every release.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://mailvaultapp.com/changelog.html">
  <meta name="theme-color" content="#6366f1">

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://mailvaultapp.com/changelog.html">
  <meta property="og:title" content="Changelog - MailVault | What's New">
  <meta property="og:description" content="See what's new in MailVault. Full changelog of features, improvements, and bug fixes for every release.">
  <meta property="og:image" content="https://mailvaultapp.com/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="MailVault">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Changelog - MailVault | What's New">
  <meta name="twitter:description" content="See what's new in MailVault. Full changelog of features, improvements, and bug fixes for every release.">
  <meta name="twitter:image" content="https://mailvaultapp.com/og-image.png">

  <link rel="icon" type="image/x-icon" href="favicon.ico">
  <link rel="icon" type="image/png" sizes="32x32" href="favicon-32x32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">

  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            primary: {
              50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc',
              400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca',
              800: '#3730a3', 900: '#312e81',
            }
          }
        }
      }
    }
  </script>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">

  <style>
    body { font-family: 'Inter', system-ui, sans-serif; }
    .gradient-text {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .gradient-bg { background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); }
    .glass {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .dark .glass {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
  </style>
</head>

<body class="bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 transition-colors duration-300">

  <!-- Navigation -->
  <nav role="banner" class="fixed top-0 left-0 right-0 z-50 glass">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-2">
          <img src="icon-128.png" alt="MailVault logo" class="w-8 h-8 rounded-lg">
          <span class="font-bold text-xl">Mail<span class="text-primary-500">Vault</span></span>
        </a>
        <button id="theme-toggle" class="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
          <svg class="w-5 h-5 hidden dark:block" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"/>
          </svg>
          <svg class="w-5 h-5 block dark:hidden" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/>
          </svg>
        </button>
      </div>
    </div>
  </nav>

  <!-- Content -->
  <main class="pt-24 pb-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <h1 class="text-4xl font-bold mb-2">Changelog</h1>
      <p class="text-slate-500 dark:text-slate-400 mb-10">New features, improvements, and fixes in every release.</p>

${articles}
      <!-- CTA -->
      <div class="mt-12 text-center">
        <p class="text-slate-600 dark:text-slate-400 mb-4">Want to try the latest version?</p>
        <div class="flex flex-col sm:flex-row gap-4 justify-center">
          <a href="https://github.com/GraphicMeat/mail-vault-app/releases/latest" target="_blank" class="gradient-bg text-white px-6 py-3 rounded-xl font-semibold hover:opacity-90 transition-opacity inline-flex items-center justify-center gap-2">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
            </svg>
            Download Latest
          </a>
          <a href="https://github.com/GraphicMeat/mail-vault-app/releases" target="_blank" class="px-6 py-3 rounded-xl font-semibold border-2 border-slate-300 dark:border-slate-600 hover:border-primary-500 transition-colors inline-flex items-center justify-center gap-2">
            All Releases on GitHub
          </a>
        </div>
      </div>
    </div>
  </main>

  <!-- Footer -->
  <footer class="py-12 border-t border-slate-200 dark:border-slate-700">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex flex-col md:flex-row items-center justify-between gap-6">
        <a href="/" class="flex items-center gap-2">
          <img src="icon-128.png" alt="MailVault logo" class="w-8 h-8 rounded-lg">
          <span class="font-bold text-lg">Mail<span class="text-primary-500">Vault</span></span>
        </a>
        <div class="flex items-center gap-6 text-sm text-slate-600 dark:text-slate-400">
          <a href="/privacy.html" class="hover:text-primary-500 transition-colors">Privacy Policy</a>
          <a href="/faq.html" class="hover:text-primary-500 transition-colors">FAQ</a>
          <a href="/changelog.html" class="hover:text-primary-500 transition-colors">Changelog</a>
          <a href="/terms.html" class="hover:text-primary-500 transition-colors">Terms of Service</a>
          <a href="https://github.com/GraphicMeat/mail-vault-app" class="hover:text-primary-500 transition-colors">GitHub</a>
        </div>
        <p class="text-sm text-slate-500 dark:text-slate-400">
          &copy; ${new Date().getFullYear()} MailVault. All rights reserved.
        </p>
      </div>
    </div>
  </footer>

  <script>
    // Theme Toggle
    const themeToggle = document.getElementById('theme-toggle');
    const html = document.documentElement;
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      html.classList.add('dark');
    }
    themeToggle.addEventListener('click', () => {
      html.classList.toggle('dark');
      localStorage.theme = html.classList.contains('dark') ? 'dark' : 'light';
    });
  </script>
</body>
</html>
`;
}

// Main
const md = fs.readFileSync(CHANGELOG_MD, 'utf-8');
const versions = parseChangelog(md);

if (versions.length === 0) {
  console.error('No versions found in CHANGELOG.md');
  process.exit(1);
}

const html = generateHTML(versions);
fs.writeFileSync(CHANGELOG_HTML, html);
console.log(`Generated website/changelog.html with ${versions.length} version(s): ${versions.map(v => 'v' + v.version).join(', ')}`);
