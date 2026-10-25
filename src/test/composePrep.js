// IO fixture for component/bridge specs. They run the real request projection,
// adapter, generation fences and rendered fields; only native RPC is replaced.
export function preparationTransport(actual) {
  return { ...actual, send: async (method, params) => {
    if (!['compose.reply_context', 'compose.check'].includes(method)) return actual.send(method, params);
    const [{ prepareDemoCompose, checkDemoCompose }, { useMailStore }, { useSettingsStore }] = await Promise.all([
      import('../demo/composePrep'), import('../stores/mailStore'), import('../stores/settingsStore'),
    ]);
    return (method === 'compose.check' ? checkDemoCompose : prepareDemoCompose)(params, { accounts: useMailStore.getState().accounts || [],
      values: { 'mailvault-settings': { state: useSettingsStore.getState() } }, version: params.expectedSettingsVersion ?? 0, now: Date.now() });
  } };
}
