// Encodes one bitmap to PNG off the main thread. WebKit's toBlob runs the
// whole encode on the calling thread (measured: 199 of 200 ms for 3200x1800),
// so a social image saved from the main thread froze the app for that long.
self.onmessage = async ({ data: bitmap }) => {
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    self.postMessage({ blob: await canvas.convertToBlob({ type: 'image/png' }) });
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
