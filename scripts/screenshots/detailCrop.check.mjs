// Self-check for detailCropBox — run with `node scripts/screenshots/detailCrop.check.mjs`.
// Not a test suite: no runner, no fixtures. Just asserts.
import assert from 'node:assert/strict';
import { detailCropBox } from './capture.js';

// A 1440x900 logical window at 2x, so the webview is 2880x1800 and exactly
// fills a 2880x1800 image with no title bar — the simplest case.
const viewport = { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2 };
const image = { width: 2880, height: 1800 };

// No padding: rect maps by a flat *dpr scale, no offset.
{
  const box = detailCropBox({ x: 100, y: 50, width: 200, height: 80 }, viewport, image, 0);
  assert.deepEqual(box, { x: 200, y: 100, width: 400, height: 160 });
}

// Padding grows the box on every side, still in device pixels.
{
  const box = detailCropBox({ x: 100, y: 50, width: 200, height: 80 }, viewport, image, 10);
  assert.deepEqual(box, { x: 180, y: 80, width: 440, height: 200 });
}

// A title bar above the webview: image is taller than innerHeight*dpr, so the
// webview sits flush with the bottom and centred horizontally.
{
  const barViewport = { innerWidth: 1440, innerHeight: 850, devicePixelRatio: 2 };
  const barImage = { width: 2900, height: 1750 }; // +20px wider, titlebar above
  const box = detailCropBox({ x: 0, y: 0, width: 10, height: 10 }, barViewport, barImage, 0);
  // offsetX = (2900 - 2880) / 2 = 10; offsetY = 1750 - 1700 = 50
  assert.deepEqual(box, { x: 10, y: 50, width: 20, height: 20 });
}

// Off the right/bottom edge: clamp, don't let sips pad with black.
{
  const box = detailCropBox({ x: 1430, y: 890, width: 100, height: 100 }, viewport, image, 0);
  assert.deepEqual(box, { x: 2860, y: 1780, width: 20, height: 20 });
}

// Fully off-screen (negative rect past the left edge) — no overlap at all.
{
  const box = detailCropBox({ x: -500, y: 0, width: 50, height: 50 }, viewport, image, 0);
  assert.equal(box, null);
}

// Fully past the bottom edge.
{
  const box = detailCropBox({ x: 0, y: 5000, width: 50, height: 50 }, viewport, image, 0);
  assert.equal(box, null);
}

console.log('detailCropBox: all assertions passed');
