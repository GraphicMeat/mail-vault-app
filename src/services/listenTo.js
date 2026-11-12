// Subscribe to a Tauri event and hand the callback the payload only. Resolves
// to the unlisten function, or to a no-op when the event API is unavailable
// (plain browser, tests without a Tauri bridge).
//
// One load of the event API, shared by every listener: two overlapping
// dynamic imports of one mocked module can resolve the second to the real
// one under vitest.
//
// A load that fails is not kept: the next call imports again, as a plain
// per-call import would.
let eventApi = null;
async function loadEventApi() {
  const loading = (eventApi ||= import('@tauri-apps/api/event'));
  try {
    return await loading;
  } catch (err) {
    if (eventApi === loading) eventApi = null;
    throw err;
  }
}

export async function listenTo(event, cb) {
  try {
    const { listen } = await loadEventApi();
    return await listen(event, (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}
