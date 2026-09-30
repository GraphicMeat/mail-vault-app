import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// TipTap's image resize draws its four corner handles as bare, unsized <div>s
// (`data-resize-handle`) and leaves every pixel of styling to the app. Without
// these rules they measure 0 x 0: the picture is selected and nothing can be
// dragged, which is how the signature editor shipped.
const css = readFileSync('src/styles/index.css', 'utf8');
const rule = (selector) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} in index.css`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
};

describe('picture resize handles', () => {
  it('give each handle a real size a pointer can hit', () => {
    const handle = rule('.tiptap [data-resize-handle]');
    expect(handle).toMatch(/width:\s*1[0-9]px/);
    expect(handle).toMatch(/height:\s*1[0-9]px/);
  });

  it('show only on the selected picture', () => {
    expect(rule('.tiptap [data-resize-handle]')).toMatch(/display:\s*none/);
    expect(rule('.tiptap .ProseMirror-selectednode[data-resize-container] [data-resize-handle]')).toMatch(/display:\s*block/);
  });

  it('point the resize cursor along the diagonal each corner drags', () => {
    expect(rule('.tiptap [data-resize-handle="top-left"]')).toContain('nwse-resize');
    expect(rule('.tiptap [data-resize-handle="bottom-right"]')).toContain('nwse-resize');
    expect(rule('.tiptap [data-resize-handle="top-right"]')).toContain('nesw-resize');
    expect(rule('.tiptap [data-resize-handle="bottom-left"]')).toContain('nesw-resize');
  });

  it('mark the selected picture so the handles read as belonging to it', () => {
    expect(rule('.tiptap .ProseMirror-selectednode[data-resize-container] img')).toMatch(/outline/);
  });
});
