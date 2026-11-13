// A full-screen layer that stays on the visible part of the screen while the on-screen keyboard is
// up (keyboardViewport.js): the `mv-kb-layer` rule in mobile.css places it from --mv-vv-top /
// --mv-vv-height. For layers whose scroller is rendered by a child that changes with the step (the
// add-account and import screens), `scroll` is a selector for it, read when a field is focused.
import React, { useMemo, useRef } from 'react';
import { useKeyboardViewport } from './keyboardViewport.js';

export default function KeyboardLayer({ as: Tag = 'div', className = '', scroll = null, children, ...rest }) {
  const layer = useRef(null);
  const scroller = useMemo(() => ({
    get current() {
      return scroll ? layer.current?.querySelector(scroll) ?? null : null;
    },
  }), [scroll]);
  useKeyboardViewport(layer, scroller);
  return (
    <Tag ref={layer} className={className ? `mv-kb-layer ${className}` : 'mv-kb-layer'} {...rest}>
      {children}
    </Tag>
  );
}
