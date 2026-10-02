import { trace } from '../exportTrace';

// A worker per encode: Save is rare, and a parked worker is memory for nothing.
function encodeInWorker(canvas) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../../workers/pngEncodeWorker.js', import.meta.url), { type: 'module' });
    const done = (fn, value) => { worker.terminate(); fn(value); };
    worker.onmessage = ({ data }) => (data.blob ? done(resolve, data.blob) : done(reject, new Error(data.error || 'PNG encode failed')));
    worker.onerror = (e) => done(reject, new Error(e?.message || 'PNG worker failed'));
    createImageBitmap(canvas).then((bitmap) => worker.postMessage(bitmap, [bitmap]), (err) => done(reject, err));
  });
}

const encodeHere = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encode produced no data'))), 'image/png');
});

const readBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => { const url = String(reader.result); resolve(url.slice(url.indexOf(',') + 1)); };
  reader.onerror = () => reject(reader.error || new Error('PNG read failed'));
  reader.readAsDataURL(blob);
});

/**
 * A canvas as base64 PNG, encoded in a worker (OffscreenCanvas) so the app
 * stays responsive; where a worker or OffscreenCanvas is missing, or the worker
 * fails, it falls back to toBlob on this thread.
 */
export async function canvasToPngBase64(canvas) {
  const t0 = performance.now();
  let blob;
  if (typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function') {
    try { blob = await encodeInWorker(canvas); } catch (err) { trace('social-encode-worker-failed', { error: String(err?.message || err) }); }
  }
  const via = blob ? 'worker' : 'main';
  if (!blob) blob = await encodeHere(canvas);
  const base64 = await readBase64(blob);
  trace('social-encode', { via, ms: Math.round(performance.now() - t0), bytes: blob.size });
  return base64;
}

// The connected e2e spec times the encode against the main thread through this.
if (import.meta.env.VITE_E2E === '1' && typeof window !== 'undefined') window.__MV_ENCODE_PNG__ = canvasToPngBase64;
