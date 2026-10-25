// IO fixture for component/bridge specs. They run the real request projection,
// adapter, generation fences and rendered fields; only native RPC is replaced.
export function preparationTransport(actual) {
  return { ...actual, send: async (method, params) => {
    if (method !== 'compose.reply_context') return actual.send(method, params);
    const [{ prepareDemoCompose }, { useMailStore }, { useSettingsStore }] = await Promise.all([
      import('../demo/composePrep'), import('../stores/mailStore'), import('../stores/settingsStore'),
    ]);
    return prepareDemoCompose(params, { accounts: useMailStore.getState().accounts || [],
      values: { 'mailvault-settings': { state: useSettingsStore.getState() } }, version: 0 });
  } };
}
