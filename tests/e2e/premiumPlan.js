/**
 * Backup to another drive is Premium in the direct build: without it the
 * daemon writes nothing to the drive (`src-daemon/src/drive_gate.rs`). The
 * daemon reads the plan from the settings file, not from the page, so a spec
 * that needs the drive sets the plan and waits until the file carries it.
 *
 * Each spec file starts from a fresh app state (`beforeSession`), so nothing
 * here needs undoing.
 */
export const PREMIUM_PLAN = { hasSubscription: true, premiumAccess: true, status: 'active', clientAccessGranted: true };

const invoke = (command, args = {}) => browser.executeAsync((c, a, done) => {
  window.__TAURI__.core.invoke(c, a).then(done, (e) => done({ __error: String(e?.message || e) }));
}, command, args);

/** The plan as the daemon will read it. */
export async function planOnDisk() {
  const s = await invoke('daemon_rpc', { method: 'settings.get', params: {} });
  return s?.values?.['mailvault-settings']?.state?.billingProfile ?? null;
}

/** Sets `plan` (null = free) and waits until the settings file has it. */
export async function usePlan(plan) {
  await browser.execute((p) => window.__SETTINGS_STORE__.setState({ billingProfile: p }), plan);
  await browser.waitUntil(async () => {
    const disk = await planOnDisk();
    return plan ? disk?.hasSubscription === true && disk?.status === plan.status : !disk?.hasSubscription;
  }, { timeout: 15_000, interval: 250, timeoutMsg: `the plan ${JSON.stringify(plan)} never reached the settings file` });
}

export const usePremiumPlan = () => usePlan(PREMIUM_PLAN);
