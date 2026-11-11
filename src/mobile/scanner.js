// The camera, for "Import from computer": the official barcode scanner plugin
// (`tauri-plugin-barcode-scanner`), reached through the global bridge like every other shell call
// (seam.test.js lists its commands). Each scan resolves with one code and closes the camera, so the
// import calls it again until every part is in. `windowed`: the camera runs behind the page (the
// webview turns transparent), so the progress and Cancel stay on screen.
//
// Rejections carry a code: `CANCELLED` (cancelScan), `CAMERA_DENIED`, `SCAN_FAILED`, `NO_TAURI`.

function codeError(code) {
  return Object.assign(new Error(code), { code });
}

function requireInvoke() {
  const invoke = (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) || null;
  if (!invoke) throw codeError('NO_TAURI');
  return invoke;
}

/** The plugin rejects with its own English text; only "cancelled" and a refused camera matter. */
function scanError(error) {
  const text = String(typeof error === 'string' ? error : error?.message ?? '').toLowerCase();
  if (text === 'cancelled' || text === 'canceled') return codeError('CANCELLED');
  if (/permission|denied|not authorized/.test(text)) return codeError('CAMERA_DENIED');
  return codeError('SCAN_FAILED');
}

/**
 * `granted` or `denied`. Asks the system only while it has not answered yet (`prompt`); a camera
 * the user turned off stays off until Settings.
 */
export async function cameraAccess() {
  const invoke = requireInvoke();
  let state = (await invoke('plugin:barcode-scanner|check_permissions'))?.camera;
  if (state === 'prompt' || state === 'prompt-with-rationale') {
    state = (await invoke('plugin:barcode-scanner|request_permissions'))?.camera;
  }
  return state === 'granted' ? 'granted' : 'denied';
}

/** The text of the next QR code the back camera sees. */
export async function scanQr() {
  const invoke = requireInvoke();
  let reply;
  try {
    reply = await invoke('plugin:barcode-scanner|scan', { windowed: true, formats: ['QR_CODE'], cameraDirection: 'back' });
  } catch (error) {
    throw scanError(error);
  }
  if (typeof reply?.content !== 'string') throw codeError('SCAN_FAILED');
  return reply.content;
}

/** Closes the camera; the running `scanQr` rejects with `CANCELLED`. Never throws. */
export async function cancelScan() {
  try {
    const invoke = requireInvoke();
    await invoke('plugin:barcode-scanner|cancel');
  } catch {
    // Nothing was scanning, or no shell.
  }
}

/** The app's page in the system Settings, where the camera can be allowed again. */
export async function openCameraSettings() {
  const invoke = requireInvoke();
  await invoke('plugin:barcode-scanner|open_app_settings');
}
