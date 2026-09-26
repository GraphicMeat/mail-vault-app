// Installer downloads across every GitHub release, for the homepage's proof line.
//
// Only installers count: the .dmg, the Windows -setup.exe, and the Linux .deb,
// .snap and .AppImage. appcast.xml, latest.json and the .sig files are fetched
// by the app itself on every update check, so counting them would report
// update checks as downloads. Snap Store installs never touch GitHub and are
// not included, so the real number is higher, never lower.
//
// Summing needs one GitHub call per 100 releases. The total is cached for an
// hour: visitors never reach GitHub, and the site's unauthenticated budget (60
// an hour, shared with /api/latest-version) is barely touched.
const RELEASES_URL = 'https://api.github.com/repos/GraphicMeat/mail-vault-app/releases?per_page=100';
const TTL = 60 * 60_000;
const MAX_PAGES = 10;

function platformOf(name) {
  if (/\.dmg$/i.test(name)) return 'mac';
  if (/-setup\.exe$/i.test(name)) return 'windows';
  if (/\.(deb|snap|AppImage|rpm)$/i.test(name)) return 'linux';
  return null;
}

function countInstallers(releases) {
  const counts = { mac: 0, windows: 0, linux: 0 };
  for (const release of releases) {
    // Drafts are invisible without a token anyway; this keeps the rule explicit.
    if (!release || release.draft) continue;
    for (const asset of release.assets || []) {
      const platform = platformOf(String(asset.name || ''));
      if (platform && Number.isInteger(asset.download_count) && asset.download_count > 0) counts[platform] += asset.download_count;
    }
  }
  return { installers: counts.mac + counts.windows + counts.linux, platforms: counts };
}

function nextLink(header) {
  const match = /<([^>]+)>;\s*rel="next"/.exec(header || '');
  return match ? match[1] : null;
}

function createDownloadCounter({ fetch = globalThis.fetch, now = Date.now, ttl = TTL } = {}) {
  let cache = null;   // { installers, platforms, ts } — kept past its TTL to serve stale
  let pending = null; // one upstream refresh at a time

  async function refresh() {
    const releases = [];
    let url = RELEASES_URL;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const response = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mailvaultapp.com' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`github ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error('unexpected releases payload');
      releases.push(...body);
      url = nextLink(response.headers.get('link'));
    }
    const counted = countInstallers(releases);
    // A total that went down means GitHub answered with a partial list; keep the
    // richer number rather than showing visitors a count that shrank.
    if (cache && counted.installers < cache.installers) throw new Error('total went down');
    cache = { ...counted, ts: now() };
    return cache;
  }

  return async function get() {
    if (cache && now() - cache.ts < ttl) return { ...cache, stale: false };
    pending ||= refresh().finally(() => { pending = null; });
    try {
      return { ...(await pending), stale: false };
    } catch (error) {
      if (cache) return { ...cache, stale: true };
      throw error;
    }
  };
}

module.exports = { createDownloadCounter, countInstallers, platformOf };
