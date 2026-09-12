#!/usr/bin/env node

/* Point the homepage at the hashed previews captured from the current demo build. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'website', 'index.html');
const manifestPath = path.join(ROOT, 'website', 'demo-preview-manifest.json');
if (!fs.existsSync(manifestPath)) throw new Error(`capture manifest missing: ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const find = (theme, viewport) => {
  const file = manifest[`en-${theme}-${viewport}`];
  if (!file || !/^demo-preview-[a-z-]+-(?:light|dark)-(?:wide|compact)-[a-f0-9]{12}\.webp$/.test(file)) {
    throw new Error(`capture manifest has no valid ${theme} ${viewport} preview`);
  }
  return `/demo/assets/${file}`;
};

const lightWide = find('light', 'wide');
const lightCompact = find('light', 'compact');
const darkWide = find('dark', 'wide');
const darkCompact = find('dark', 'compact');
const dimensions = manifest._dimensions?.wide;
if (!dimensions || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height)) {
  throw new Error('capture manifest has no valid wide image dimensions');
}
let html = fs.readFileSync(INDEX, 'utf8');
html = html.replace(/(<source data-shot-dark[^>]*\bsrcset=")[^"]+/,
  `$1${darkCompact} 720w, ${darkWide} 1440w`);
html = html.replace(/(<img\s+src=")[^"]+("\s+srcset=")[^"]+/, `$1${lightWide}$2${lightCompact} 720w, ${lightWide} 1440w`);
html = html.replace(/(<img\s+src="[^"]+"\s+srcset="[^"]+"\s+sizes="[^"]+"\s+width=")[0-9]+("\s+height=")[0-9]+/, `$1${dimensions.width}$2${dimensions.height}`);
fs.writeFileSync(INDEX, html);
console.log(`homepage preview: ${lightCompact}, ${lightWide}, ${darkCompact}, ${darkWide}`);
