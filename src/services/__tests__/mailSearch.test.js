import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  listen: vi.fn(),
  send: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: bridge.listen }));
vi.mock('../transport.js', () => ({ send: bridge.send }));

const { cancelMailSearch, startMailSearch } = await import('../mailSearch.js');

describe('mail search daemon adapter', () => {
  beforeEach(() => {
    bridge.listen.mockReset().mockResolvedValue(bridge.unlisten);
    bridge.send.mockReset().mockResolvedValue(undefined);
    bridge.unlisten.mockReset();
  });

  it('installs the progress listener before starting and returns its unlisten function', async () => {
    const order = [];
    let onEvent;
    bridge.listen.mockImplementation(async (name, callback) => {
      order.push(`listen:${name}`);
      onEvent = callback;
      return bridge.unlisten;
    });
    bridge.send.mockImplementation(async command => { order.push(`send:${command}`); });
    const onProgress = vi.fn();
    const request = { searchId: 's1', query: 'invoice' };

    const result = await startMailSearch(request, onProgress);
    onEvent({ event: 'different-event', payload: { ignored: true } });
    onEvent({ event: 'mail-search-progress', payload: { phase: 'local' } });

    expect(order).toEqual(['listen:mail-search-progress', 'send:mail_search_start']);
    expect(bridge.send).toHaveBeenCalledWith('mail_search_start', request);
    expect(onProgress).not.toHaveBeenCalledWith({ ignored: true });
    expect(onProgress).toHaveBeenCalledWith({ phase: 'local' });
    expect(result).toEqual({ unlisten: bridge.unlisten });
  });

  it('removes the listener when starting the daemon search fails', async () => {
    const error = new Error('daemon unavailable');
    bridge.send.mockRejectedValue(error);

    await expect(startMailSearch({ searchId: 's2' }, vi.fn())).rejects.toBe(error);

    expect(bridge.unlisten).toHaveBeenCalledOnce();
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
