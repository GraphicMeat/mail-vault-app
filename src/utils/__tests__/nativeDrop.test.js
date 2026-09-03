// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mimeFromName, toClientPoint, dropZoneAt, toAttachment } from '../nativeDrop';

describe('nativeDrop', () => {
  it('guesses the content type from the extension', () => {
    expect(mimeFromName('Screenshot 2026-09-03 at 12.04.41.png')).toBe('image/png');
    expect(mimeFromName('notes.PDF')).toBe('application/pdf');
    expect(mimeFromName('Makefile')).toBe('application/octet-stream');
    expect(mimeFromName('.hidden')).toBe('application/octet-stream');
  });

  it('keeps a point that fits the viewport and scales one reported in device pixels', () => {
    const view = { dpr: 2, width: 1000, height: 800 };
    expect(toClientPoint({ x: 300, y: 500 }, view)).toEqual({ x: 300, y: 500 });
    expect(toClientPoint({ x: 1200, y: 400 }, view)).toEqual({ x: 600, y: 200 });
    expect(toClientPoint(undefined, view)).toEqual({ x: 0, y: 0 });
  });

  it('names the zone by the element under the point', () => {
    const modal = document.createElement('div');
    modal.dataset.testid = 'compose-modal';
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const strip = document.createElement('div');
    modal.append(editor, strip);
    document.body.append(modal);
    expect(dropZoneAt({ x: 1, y: 1 }, () => editor)).toBe('editor');
    expect(dropZoneAt({ x: 1, y: 1 }, () => strip)).toBe('attach');
    expect(dropZoneAt({ x: 1, y: 1 }, () => document.body)).toBeNull();
    expect(dropZoneAt({ x: 1, y: 1 }, () => null)).toBeNull();
    modal.remove();
  });

  it('maps a read record onto the attachment shape', () => {
    expect(toAttachment({ name: 'shot.png', size: 3, content: 'AAAA' })).toEqual({
      filename: 'shot.png', contentType: 'image/png', size: 3, content: 'AAAA', isFromOriginal: false,
    });
  });
});
