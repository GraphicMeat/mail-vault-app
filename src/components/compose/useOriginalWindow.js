import { useEffect, useRef, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export function useOriginalWindow({ shownContextHtml, originalDark, setError }) {
  const [originalDetached, setOriginalDetached] = useState(false);

  const originalWindowRef = useRef(null);
  const originalCloseStopRef = useRef(null);

  useEffect(() => () => {
    originalCloseStopRef.current?.();
    void originalWindowRef.current?.destroy();
  }, []);

  const openOriginalWindow = async () => {
    if (originalWindowRef.current) {
      await originalWindowRef.current.setFocus();
      return;
    }
    const token = crypto.randomUUID();
    let unlisten;
    try {
      unlisten = await listen('original-message-ready', async event => {
        if (event.payload?.token !== token) return;
        await emitTo(event.payload.label, 'original-message-payload', { token, html: shownContextHtml, dark: originalDark });
        unlisten?.();
      });
      const label = await invoke('open_auxiliary_window', { kind: 'original', token });
      const window = await WebviewWindow.getByLabel(label);
      if (!window) throw new Error('Original message window did not open');
      originalWindowRef.current = window;
      setOriginalDetached(true);
      originalCloseStopRef.current = await window?.onCloseRequested(() => {
        originalCloseStopRef.current?.();
        originalCloseStopRef.current = null;
        originalWindowRef.current = null;
        setOriginalDetached(false);
      });
    } catch (cause) {
      unlisten?.();
      setError(cause?.message || String(cause));
    }
  };

  return { originalDetached, openOriginalWindow };
}
