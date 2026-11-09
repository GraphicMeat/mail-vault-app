// A 1x1 transparent PNG. `start_drag` requires a drag image and rejects
// anything that is not PNG data; this stands in when rendering the row fails.
export const DRAG_FALLBACK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export async function startFileDrag(path, image) {
  const { Channel } = await import('@tauri-apps/api/core');
  // The LIVE global bridge, as in the attachment row: the
  // module's copy talks to `__TAURI_INTERNALS__` directly, which no e2e
  // fixture can swap — and an unstubbed start_drag on the runner opens a
  // real drag session.
  return window.__TAURI__.core.invoke('plugin:drag|start_drag', {
    item: [path],
    image,
    // The plugin's callback is not optional; nothing here needs the drop
    // result, so it is drained.
    onEvent: new Channel(),
  });
}
