#!/usr/bin/env node

/*
 * Capture the deployed browser demo with an isolated headless Chrome session.
 * The script owns its short lived static server when --url is omitted, so a
 * release cannot accidentally point a screenshot job at a user's browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startWebDriver } from '@wdio/utils';
import { remote } from 'webdriverio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBSITE = path.join(ROOT, 'website');
const DEFAULT_OUT = path.join(WEBSITE, 'demo', 'assets');
const VIEWPORTS = [
  { name: 'wide', width: 1440, height: 932 },
];
const THEMES = ['light', 'dark'];
const LOCALES = [
  ['en', 'en'], ['de', 'de'], ['fr', 'fr'], ['es', 'es'], ['it', 'it'],
  ['ja', 'ja'], ['ko', 'ko'], ['zh', 'zh-Hans'], ['pt-br', 'pt-BR'],
];
const MAX_BYTES = Number(process.env.DEMO_PREVIEW_MAX_BYTES || 120_000);
const VIEWPORT_BUDGETS = { wide: MAX_BYTES, compact: Math.min(MAX_BYTES, 60_000) };
const CWEBP = process.env.CWEBP || ['/opt/homebrew/bin/cwebp', '/usr/local/bin/cwebp', '/usr/bin/cwebp']
  .find((candidate) => fs.existsSync(candidate)) || 'cwebp';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1] || fallback;
}

function mime(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream';
}

function startServer() {
  const server = http.createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
    const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    const candidate = path.resolve(WEBSITE, relative);
    if (candidate !== WEBSITE && !candidate.startsWith(`${WEBSITE}${path.sep}`)) {
      response.writeHead(400); response.end('bad path'); return;
    }
    let file = candidate;
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      response.writeHead(200, { 'Content-Type': mime(file), 'Cache-Control': 'no-store' });
      fs.createReadStream(file).on('error', () => { response.writeHead(404); response.end('not found'); }).pipe(response);
    } catch { response.writeHead(404); response.end('not found'); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitForDemo(browser) {
  await browser.waitUntil(
    async () => {
      const result = await browser.execute(() => document.readyState === 'complete'
      && !!document.querySelector('[data-testid="email-row"]')
        && !document.querySelector('[aria-busy="true"],[data-testid="loading"]'));
      return result?.value ?? result;
    },
    { timeout: 20_000, timeoutMsg: 'the browser demo did not finish rendering' },
  );
}

async function setTheme(browser, theme) {
  const icon = theme === 'light' ? 'sun' : 'moon';
  const toggle = await browser.$(`button:has(svg.lucide-${icon})`);
  if (!(await toggle.isExisting())) throw new Error(`sidebar theme toggle for ${theme} is missing`);
  await toggle.click();
  await browser.waitUntil(async () => {
    const result = await browser.execute((nextTheme) => document.documentElement.dataset.theme === nextTheme, theme);
    return result?.value ?? result;
  }, { timeout: 10_000, timeoutMsg: `demo did not apply the ${theme} theme` });
  await browser.execute(() => window.__MAILVAULT_DEMO__?.flush?.());
}

async function openRepresentative(browser) {
  const row = await browser.$('[data-testid="email-row"]');
  await row.click();
  await browser.waitUntil(async () => {
    const result = await browser.execute(() => !!document.querySelector('.email-reader h1,.thread-reader h1')
      && !document.querySelector('[data-testid="email-viewer-loading"]')
      && !!document.querySelector('.email-reader iframe,.email-reader .email-content,.thread-reader iframe,.thread-reader .email-content'));
    return result?.value ?? result;
  }, { timeout: 20_000, timeoutMsg: 'the representative demo message did not finish opening' });
}

async function main() {
  const output = path.resolve(arg('out-dir', DEFAULT_OUT));
  const suppliedUrl = arg('url', '');
  let server;
  let baseUrl = suppliedUrl;
  if (!baseUrl) {
    server = await startServer();
    baseUrl = `http://127.0.0.1:${server.port}/demo/`;
  }
  fs.mkdirSync(output, { recursive: true });
  const captured = {};

  const options = {
    logLevel: 'warn',
    ...(process.env.WEBDRIVER_URL ? { hostname: new URL(process.env.WEBDRIVER_URL).hostname, port: Number(new URL(process.env.WEBDRIVER_URL).port || 80) } : {}),
    capabilities: {
      browserName: 'chrome',
      'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] },
    },
  };
  let driver = null;
  let browser = null;
  try {
    if (!process.env.WEBDRIVER_URL) driver = await startWebDriver(options);
    browser = await remote(options);
    for (const [directory, appLocale] of LOCALES) {
      for (const viewport of VIEWPORTS) {
        await browser.setWindowSize(viewport.width, viewport.height);
        for (const theme of THEMES) {
          await browser.url(`${baseUrl}?lang=${encodeURIComponent(appLocale)}`);
          await waitForDemo(browser);
          await setTheme(browser, theme);
          await openRepresentative(browser);
          const stem = `demo-preview-${directory}-${theme}-${viewport.name}`;
          const png = path.join(output, `.${stem}.png`);
          const rawWebp = path.join(output, `.${stem}.webp`);
          await browser.saveScreenshot(png);
          const pngData = fs.readFileSync(png);
          const pngWidth = pngData.readUInt32BE(16);
          const pngHeight = pngData.readUInt32BE(20);
          execFileSync(CWEBP, ['-quiet', '-q', '82', png, '-o', rawWebp], { stdio: 'ignore' });
          fs.rmSync(png, { force: true });
          const digest = crypto.createHash('sha256').update(fs.readFileSync(rawWebp)).digest('hex').slice(0, 12);
          const webp = path.join(output, `${stem}-${digest}.webp`);
          fs.renameSync(rawWebp, webp);
          const bytes = fs.statSync(webp).size;
          const budget = VIEWPORT_BUDGETS[viewport.name];
          if (bytes > budget) throw new Error(`${path.basename(webp)} is ${bytes} bytes; budget is ${budget}`);
          captured[`${directory}-${theme}-${viewport.name}`] = path.basename(webp);
          captured._dimensions ||= { wide: { width: pngWidth, height: pngHeight } };
          console.log(`${path.relative(ROOT, webp)} (${bytes} bytes)`);
          const compactStem = `demo-preview-${directory}-${theme}-compact`;
          const compactRaw = path.join(output, `.${compactStem}.webp`);
          execFileSync(CWEBP, ['-quiet', '-resize', '720', '0', webp, '-o', compactRaw], { stdio: 'ignore' });
          const compactDigest = crypto.createHash('sha256').update(fs.readFileSync(compactRaw)).digest('hex').slice(0, 12);
          const compactWebp = path.join(output, `${compactStem}-${compactDigest}.webp`);
          fs.renameSync(compactRaw, compactWebp);
          const compactBytes = fs.statSync(compactWebp).size;
          if (compactBytes > VIEWPORT_BUDGETS.compact) throw new Error(`${path.basename(compactWebp)} is ${compactBytes} bytes; budget is ${VIEWPORT_BUDGETS.compact}`);
          captured[`${directory}-${theme}-compact`] = path.basename(compactWebp);
          captured._dimensions.compact = { width: 720, height: Math.round(pngHeight * 720 / pngWidth) };
          console.log(`${path.relative(ROOT, compactWebp)} (${compactBytes} bytes)`);
        }
      }
    }
    fs.writeFileSync(path.join(ROOT, 'website', 'demo-preview-manifest.json'), `${JSON.stringify(captured, null, 2)}\n`);
  } finally {
    if (browser) await browser.deleteSession();
    if (driver) driver.kill();
    if (server) await new Promise((resolve) => server.server.close(resolve));
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
