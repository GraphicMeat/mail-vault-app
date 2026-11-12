import { useSendState } from './useSendState';
import { useEffect, useRef, useState } from 'react';
import { dropZoneAt, toAttachment, toClientPoint } from '../../utils/nativeDrop';
import { invoke } from '@tauri-apps/api/core';
import { insertImages } from '../RichTextEditor';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';

export function useComposeAttachments({ invalidate, detaching, fileInputRef, editorRef, setError }) {
  const [attachments, setAttachments] = useSendState([], invalidate);

  // WebKit reports a null relatedTarget on dragleave, so the old
  // `contains(relatedTarget)` check never worked — count enter/leave instead.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  // Shared by the file picker, the modal-wide drop fallback, the dashed attach
  // strip, and non-image files dropped on the editor.
  const addFiles = (files) => {
    if (detaching) return;
    for (const file of files) {
      // Read file as base64
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        setAttachments(prev => [...prev, {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          content: base64,
          isFromOriginal: false
        }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleFileSelect = (e) => {
    if (detaching) return;
    addFiles(Array.from(e.target.files || []));
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e) => {
    if (detaching) return;
    e.preventDefault();
    e.stopPropagation();
    addFiles(Array.from(e.dataTransfer?.files || []));
  };

  const removeAttachment = (index) => {
    if (detaching) return;
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Native file drops. In the app a file drag never reaches WebKit (see
  // src/utils/nativeDrop.js): Tauri reports enter/leave for the zone visuals
  // and the drop as pasteboard paths plus the pointer position. The element
  // under that point picks the zone, as the HTML5 handlers do by target.
  useEffect(() => {
    if (!window.__TAURI__ || document.body.dataset.mailvaultDemo === 'true') return undefined;
    let disposed = false;
    const stops = [];
    const onDrop = async ({ paths = [], position } = {}) => {
      if (detaching) return;
      dragDepth.current = 0;
      setDragging(false);
      const point = toClientPoint(position, {
        dpr: window.devicePixelRatio, width: window.innerWidth, height: window.innerHeight,
      });
      const zone = dropZoneAt(point, (x, y) => document.elementFromPoint(x, y));
      if (!zone || !paths.length) return;
      try {
        const records = (await invoke('read_dropped_files', { paths })).map(toAttachment);
        const inline = zone === 'editor' ? records.filter(r => r.contentType.startsWith('image/')) : [];
        const attach = records.filter(r => !inline.includes(r));
        if (inline.length) {
          const editor = editorRef.current;
          const pos = editor?.view?.posAtCoords({ left: point.x, top: point.y })?.pos ?? null;
          insertImages(editor, inline.map(r => ({ src: `data:${r.contentType};base64,${r.content}`, name: r.filename })), pos);
        }
        if (attach.length) setAttachments(prev => [...prev, ...attach]);
      } catch (e) {
        setError(String(e?.message ?? e));
      }
    };
    const target = { target: getCurrentWebviewWindow().label };
    Promise.all([
      listen('tauri://drag-enter', () => { if (!detaching) setDragging(true); }, target),
      listen('tauri://drag-leave', () => { if (!detaching) setDragging(false); }, target),
      listen('tauri://drag-drop', (ev) => onDrop(ev.payload), target),
    ]).then((fns) => { if (disposed) fns.forEach(f => f()); else stops.push(...fns); }).catch(() => {});
    return () => { disposed = true; stops.forEach(f => f()); };
  }, [detaching]);

  return { attachments, setAttachments, dragging, setDragging, dragDepth, addFiles, handleFileSelect, handleDrop, removeAttachment };
}
