// @vitest-environment jsdom
//
// Compose has ONE scroll view. The editor used to wrap its content in its own
// `overflow-y-auto` box inside the compose window's scroller, so a long message
// showed two scrollbars, one inside the other. In compose the editor grows with
// its content (`autoGrow`) and the compose window scrolls; everywhere else
// (the signature editor) the editor keeps scrolling itself inside a fixed box.
//
// jsdom has no layout, so this reads the class list: a scroll box here is an
// element whose classes say `overflow-y-auto` / `overflow-auto` / `overflow-*-scroll`.

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

import { vi } from 'vitest';
vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

const settings = { spellcheckEnabled: true };
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  return { useSettingsStore: hook };
});

const { RichTextEditor } = await import('../RichTextEditor');

const SCROLL_CLASS = /(^|\s)overflow(-[xy])?-(auto|scroll)(\s|$)/;
const scrollBoxes = (root) =>
  [root, ...root.querySelectorAll('*')].filter((el) => SCROLL_CLASS.test(el.getAttribute('class') || ''));

afterEach(cleanup);

describe('RichTextEditor scrolling', () => {
  it('autoGrow: owns no scroll box, the compose window scrolls instead', () => {
    const { container } = render(<RichTextEditor content="<p>hello</p>" onUpdate={() => {}} autoGrow />);
    expect(scrollBoxes(container)).toEqual([]);
  });

  it('autoGrow: does not clip or squash its content either', () => {
    const { container } = render(<RichTextEditor content="<p>hello</p>" onUpdate={() => {}} autoGrow />);
    const clipped = [...container.querySelectorAll('*')].filter((el) => {
      const c = el.getAttribute('class') || '';
      return /(^|\s)overflow-hidden(\s|$)/.test(c) || /(^|\s)min-h-0(\s|$)/.test(c);
    });
    expect(clipped).toEqual([]);
  });

  it('autoGrow: keeps the toolbar in view while the compose window scrolls', () => {
    const { container } = render(<RichTextEditor content="<p>hello</p>" onUpdate={() => {}} autoGrow />);
    const toolbar = container.querySelector('[data-testid="editor-toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar.className).toMatch(/(^|\s)sticky(\s|$)/);
    expect(toolbar.className).toMatch(/(^|\s)top-0(\s|$)/);
  });

  it('without autoGrow: still scrolls itself, the signature editor has no outer scroller', () => {
    const { container } = render(<RichTextEditor content="<p>hello</p>" onUpdate={() => {}} />);
    expect(scrollBoxes(container)).toHaveLength(1);
  });
});
