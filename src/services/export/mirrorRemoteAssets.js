import { t } from '../../i18n/index.js';

// Turns a body into a static mirror: every remote reference becomes a data:
// URI so the exported file renders with the network unplugged, forever.
//
// The fetcher is INJECTED. Tests stub this seam; they never touch the network.

export const DEFAULT_CAPS = {
  perAssetBytes: 5_242_880,
  perDocBytes: 52_428_800,
  concurrency: 6,
};

const REMOTE = /^https?:\/\//i;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

const isPixel = (w, h) => (w != null && w <= 2) || (h != null && h <= 2);

// One fetch per distinct URL, capped concurrency, results shared by every
// reference to that URL.
function makeLoader(fetchAsset, caps, stats) {
  const cache = new Map();
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < caps.concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      job().finally(() => { active -= 1; pump(); });
    }
  };

  return (url) => {
    if (cache.has(url)) return cache.get(url);
    const promise = new Promise((resolve) => {
      queue.push(async () => {
        try {
          if (stats.bytes >= caps.perDocBytes) throw new Error('document cap reached');
          const asset = await fetchAsset(url);
          if (!asset || asset.bytes > caps.perAssetBytes) throw new Error('asset cap exceeded');
          if (stats.bytes + asset.bytes > caps.perDocBytes) throw new Error('document cap reached');
          stats.bytes += asset.bytes;
          resolve(asset);
        } catch (err) {
          resolve(null);
        }
      });
      pump();
    });
    cache.set(url, promise);
    return promise;
  };
}

async function rewriteCssUrls(css, load, stats) {
  const urls = [...css.matchAll(CSS_URL)].map(m => m[2]).filter(u => REMOTE.test(u));
  const resolved = new Map();
  await Promise.all(urls.map(async (u) => {
    const asset = await load(u);
    if (asset) { resolved.set(u, `data:${asset.mime};base64,${asset.base64}`); stats.mirrored += 1; }
    else { stats.failed += 1; }
  }));
  return css.replace(CSS_URL, (whole, quote, url) =>
    resolved.has(url) ? `url("${resolved.get(url)}")` : whole);
}

function placeholder(doc, el, url) {
  const box = doc.createElement('span');
  box.setAttribute('data-mv-remote-src', url);
  box.setAttribute('style', 'display:inline-block;padding:6px 10px;border:1px dashed #b0b0b0;color:#6b6b6b;font:12px -apple-system,sans-serif;border-radius:4px');
  let host = url;
  try { host = new URL(url).host; } catch (_) {}
  box.textContent = t('export.imageNotMirrored', { host });
  el.replaceWith(box);
}

export async function mirrorRemoteAssets(html, { fetchAsset, caps = DEFAULT_CAPS } = {}) {
  const stats = { mirrored: 0, failed: 0, pixelsRemoved: 0, bytes: 0 };
  if (!html) return { html: '', stats };

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const load = makeLoader(fetchAsset, caps, stats);

  // Declared tracking pixels never reach the network at all.
  doc.body.querySelectorAll('img[src]').forEach((img) => {
    const w = img.getAttribute('width');
    const h = img.getAttribute('height');
    if (REMOTE.test(img.getAttribute('src')) && isPixel(w && +w, h && +h)) {
      img.remove();
      stats.pixelsRemoved += 1;
    }
  });

  const jobs = [];

  doc.body.querySelectorAll('img[src]').forEach((img) => {
    const url = img.getAttribute('src');
    if (!REMOTE.test(url)) return;
    jobs.push((async () => {
      const asset = await load(url);
      if (!asset) { stats.failed += 1; placeholder(doc, img, url); return; }
      if (isPixel(asset.width, asset.height)) { img.remove(); stats.pixelsRemoved += 1; return; }
      img.setAttribute('src', `data:${asset.mime};base64,${asset.base64}`);
      stats.mirrored += 1;
    })());
  });

  doc.body.querySelectorAll('img[srcset]').forEach((img) => {
    jobs.push((async () => {
      const parts = img.getAttribute('srcset').split(',').map(s => s.trim()).filter(Boolean);
      const out = [];
      for (const part of parts) {
        const [url, descriptor] = part.split(/\s+/, 2);
        if (!REMOTE.test(url)) { out.push(part); continue; }
        const asset = await load(url);
        if (!asset) { stats.failed += 1; continue; }
        stats.mirrored += 1;
        out.push(`data:${asset.mime};base64,${asset.base64}${descriptor ? ` ${descriptor}` : ''}`);
      }
      if (out.length) img.setAttribute('srcset', out.join(', '));
      else img.removeAttribute('srcset');
    })());
  });

  doc.body.querySelectorAll('[background]').forEach((el) => {
    const url = el.getAttribute('background');
    if (!REMOTE.test(url)) return;
    jobs.push((async () => {
      const asset = await load(url);
      if (!asset) { stats.failed += 1; el.removeAttribute('background'); return; }
      el.setAttribute('background', `data:${asset.mime};base64,${asset.base64}`);
      stats.mirrored += 1;
    })());
  });

  // Filtered in JS, not by [style*="url("]: nwsapi cannot match a parenthesis
  // inside an attribute-substring value, so that selector silently finds
  // nothing under jsdom and every inline background survives the mirror.
  doc.body.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style') || '';
    if (!style.includes('url(')) return;
    jobs.push((async () => {
      el.setAttribute('style', await rewriteCssUrls(style, load, stats));
    })());
  });

  doc.body.querySelectorAll('style').forEach((styleEl) => {
    jobs.push((async () => {
      styleEl.textContent = await rewriteCssUrls(styleEl.textContent || '', load, stats);
    })());
  });

  doc.body.querySelectorAll('link[rel~="stylesheet" i][href]').forEach((link) => {
    const url = link.getAttribute('href');
    jobs.push((async () => {
      const asset = REMOTE.test(url) ? await load(url) : null;
      if (!asset) { stats.failed += 1; link.remove(); return; }
      stats.mirrored += 1;
      const style = doc.createElement('style');
      // One level of recursion: a sheet's own url()s, not sheets it imports.
      style.textContent = await rewriteCssUrls(atob(asset.base64), load, stats);
      link.replaceWith(style);
    })());
  });

  await Promise.all(jobs);
  return { html: doc.body.innerHTML, stats };
}
