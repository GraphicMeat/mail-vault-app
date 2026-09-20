import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  listen: vi.fn(),
  onDaemonReconnected: vi.fn(),
  send: vi.fn(),
  unlisten: vi.fn(),
  reconnectUnlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: bridge.listen }));
vi.mock('../transport.js', () => ({ send: bridge.send }));
vi.mock('../searchIndex.js', () => ({ onDaemonReconnected: (...args) => bridge.onDaemonReconnected(...args) }));

const { cancelMailSearch, startMailSearch } = await import('../mailSearch.js');

describe('mail search daemon adapter', () => {
  beforeEach(() => {
    bridge.listen.mockReset().mockResolvedValue(bridge.unlisten);
    bridge.onDaemonReconnected.mockReset().mockResolvedValue(bridge.reconnectUnlisten);
    bridge.send.mockReset().mockResolvedValue(undefined);
    bridge.unlisten.mockReset();
    bridge.reconnectUnlisten.mockReset();
  });

  it('installs the progress listener before starting and returns its unlisten function', async () => {
    const order = [];
    let onEvent;
    bridge.listen.mockImplementation(async (name, callback) => {
      order.push(`listen:${name}`);
      onEvent = callback;
      return bridge.unlisten;
    });
    bridge.onDaemonReconnected.mockImplementation(async () => {
      order.push('listen:daemon-reconnected');
      return bridge.reconnectUnlisten;
    });
    bridge.send.mockImplementation(async command => { order.push(`send:${command}`); });
    const onProgress = vi.fn();
    const request = { searchId: 's1', query: 'invoice' };

    const result = await startMailSearch(request, onProgress);
    onEvent({ event: 'different-event', payload: { ignored: true } });
    onEvent({ event: 'mail-search-progress', payload: { phase: 'local' } });

    expect(order).toEqual(['listen:mail-search-progress', 'listen:daemon-reconnected', 'send:mail_search_start']);
    expect(bridge.send).toHaveBeenCalledWith('mail_search_start', request);
    expect(onProgress).not.toHaveBeenCalledWith({ ignored: true });
    expect(onProgress).toHaveBeenCalledWith({ phase: 'local' });
    expect(typeof result.unlisten).toBe('function');
    result.unlisten();
    expect(bridge.unlisten).toHaveBeenCalledOnce();
    expect(bridge.reconnectUnlisten).toHaveBeenCalledOnce();
  });

  it('removes the listener when starting the daemon search fails', async () => {
    const error = new Error('daemon unavailable');
    bridge.send.mockRejectedValue(error);

    await expect(startMailSearch({ searchId: 's2' }, vi.fn())).rejects.toBe(error);

    expect(bridge.unlisten).toHaveBeenCalledOnce();
    expect(bridge.reconnectUnlisten).toHaveBeenCalledOnce();
  });

  it('watches daemon reconnects for an acknowledged run and releases both listeners', async () => {
    let onDaemonReconnect;
    bridge.onDaemonReconnected.mockImplementation(async callback => {
      onDaemonReconnect = callback;
      return bridge.reconnectUnlisten;
    });
    const onReconnect = vi.fn();
    const result = await startMailSearch({ searchId: 's4' }, vi.fn(), onReconnect);

    expect(bridge.onDaemonReconnected).toHaveBeenCalledOnce();
    onDaemonReconnect();
    expect(onReconnect).toHaveBeenCalledOnce();

    result.unlisten();
    expect(bridge.unlisten).toHaveBeenCalledOnce();
    expect(bridge.reconnectUnlisten).toHaveBeenCalledOnce();
  });

  it('ignores the reconnect event while the start acknowledgement is pending', async () => {
    let onDaemonReconnect;
    let acknowledgeStart;
    let sendStarted;
    const started = new Promise(resolve => { sendStarted = resolve; });
    bridge.onDaemonReconnected.mockImplementation(async callback => {
      onDaemonReconnect = callback;
      return bridge.reconnectUnlisten;
    });
    bridge.send.mockImplementation(() => {
      sendStarted();
      return new Promise(resolve => { acknowledgeStart = resolve; });
    });
    const onReconnect = vi.fn();
    const pendingStart = startMailSearch({ searchId: 's5' }, vi.fn(), onReconnect);
    await started;

    onDaemonReconnect();
    expect(onReconnect).not.toHaveBeenCalled();
    acknowledgeStart();
    const { unlisten } = await pendingStart;
    onDaemonReconnect();
    expect(onReconnect).toHaveBeenCalledOnce();
    unlisten();
  });

  it('sends cancellation and treats daemon shutdown as best effort', async () => {
    bridge.send.mockRejectedValue(new Error('daemon stopped'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(cancelMailSearch('s3')).resolves.toBeUndefined();

    expect(bridge.send).toHaveBeenCalledWith('mail_search_cancel', { searchId: 's3' });
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
});
