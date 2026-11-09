// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeChannel {}
vi.mock('@tauri-apps/api/core', () => ({ Channel: FakeChannel }));

import { startFileDrag } from '../fileDrag';

const invoke = vi.fn();
beforeEach(() => {
  invoke.mockReset();
  window.__TAURI__ = { core: { invoke } };
});

describe('startFileDrag', () => {
  it('passes one disk path and its PNG drag image to the native plugin', async () => {
    invoke.mockResolvedValue(null);
    await startFileDrag('/cache/chart.png', 'data:image/png;base64,IMAGE');
    expect(invoke).toHaveBeenCalledWith('plugin:drag|start_drag', {
      item: ['/cache/chart.png'], image: 'data:image/png;base64,IMAGE', onEvent: expect.any(FakeChannel),
    });
  });

  it('propagates a rejected native drag', async () => {
    invoke.mockRejectedValue(new Error('drag failed'));
    await expect(startFileDrag('/cache/chart.png', 'data:image/png;base64,IMAGE')).rejects.toThrow('drag failed');
  });
});
