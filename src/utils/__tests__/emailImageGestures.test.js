// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

const { stageFile, startFileDrag, openInDefaultApp } = vi.hoisted(() => ({
  stageFile: vi.fn(async () => '/cache/mailvault-export/image.png'),
  startFileDrag: vi.fn(async () => {}),
  openInDefaultApp: vi.fn(async () => '/cache/mailvault-export/image.png'),
}));
vi.mock('../../services/export/exportSaver', () => ({ stageFile, openInDefaultApp }));
vi.mock('../../services/fileDrag', () => ({
  DRAG_FALLBACK_PNG: 'data:image/png;base64,FALLBACK', startFileDrag,
}));
import { attachImageGestures } from '../emailImageGestures';
import '../../services/workflows/bindStoreActions';

afterEach(() => { delete window.__TAURI__; document.body.innerHTML = ''; vi.clearAllMocks(); });

const fire = (image, type) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  image.dispatchEvent(event);
  return event;
};

describe('attachImageGestures', () => {
  it('opens on double click and starts native drag on the same image', async () => {
    window.__TAURI__ = {};
    document.body.innerHTML = '<img src="data:image/png;base64,AAAA">';
    const detach = attachImageGestures(document, () => []);
    const image = document.querySelector('img');
    expect(fire(image, 'dblclick').defaultPrevented).toBe(true);
    expect(fire(image, 'dragstart').defaultPrevented).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(openInDefaultApp).toHaveBeenCalledTimes(1);
    expect(startFileDrag).toHaveBeenCalledTimes(1);
    detach();
  });

  it('detaches both gestures', async () => {
    window.__TAURI__ = {};
    document.body.innerHTML = '<img src="data:image/png;base64,AAAA">';
    const detach = attachImageGestures(document, () => []);
    detach();
    const image = document.querySelector('img');
    expect(fire(image, 'dblclick').defaultPrevented).toBe(false);
    expect(fire(image, 'dragstart').defaultPrevented).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(openInDefaultApp).not.toHaveBeenCalled();
    expect(startFileDrag).not.toHaveBeenCalled();
  });
});
