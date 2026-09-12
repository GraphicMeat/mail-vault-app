#!/usr/bin/env node
/**
 * Small, dependency-free helpers shared by the website deploy and its tests.
 *
 * The demo emits content-hashed files. Those files can be safely cached for a
 * week because a changed build gets a new URL. HTML stays revalidated so a
 * fresh entry point can select the newest asset set on the next navigation.
 */

export const DEMO_CACHE_SECONDS = 7 * 24 * 60 * 60;
export const DEMO_ASSET_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

const HASHED_DEMO_ASSET = /\/demo\/assets\/[\w.-]+-[\w-]{6,}\.(?:js|css|webp|png|svg|woff2?)$/i;
const DEMO_HTML = /^\/demo(?:\/index\.html|\/?)$/i;

export function isHashedDemoAsset(pathname) {
  if (typeof pathname !== 'string') return false;
  const clean = pathname.split(/[?#]/, 1)[0];
  return HASHED_DEMO_ASSET.test(clean);
}

export function cacheControlForPath(pathname) {
  if (isHashedDemoAsset(pathname)) return `public, max-age=${DEMO_CACHE_SECONDS}, immutable`;
  if (DEMO_HTML.test(pathname) || pathname === '/' || pathname === '/index.html') return 'no-cache';
  return null;
}

/**
 * Return whether a file is within the grace window needed by tabs from the
 * previous demo build. Boundary timestamps are retained; pruning starts only
 * after the full eight days have elapsed.
 */
export function shouldRetainDemoAsset(pathname, mtimeMs, nowMs = Date.now()) {
  if (!isHashedDemoAsset(pathname)) return false;
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - mtimeMs <= DEMO_ASSET_RETENTION_MS;
}

/**
 * Model the deploy manifest policy without touching a host. Active files are
 * always kept; files removed from the active manifest stay for eight days from
 * retirement, independent of the source file's original mtime.
 */
export function retainedDemoAssets({ current = [], previous = [], retiredAt = {}, nowMs = Date.now() }) {
  const active = new Set(current);
  for (const pathname of previous) {
    if (active.has(pathname)) continue;
    const retired = retiredAt[pathname];
    if (Number.isFinite(retired) && nowMs - retired <= DEMO_ASSET_RETENTION_MS) active.add(pathname);
  }
  return active;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const path = process.argv[2];
  const policy = cacheControlForPath(path);
  if (!path || !policy) process.exitCode = 1;
  else console.log(policy);
}
