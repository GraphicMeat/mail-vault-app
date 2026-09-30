/// How code looks in a message. Mail clients drop <style> blocks and know no CSS
/// variables, so the look is written into the message itself (compose), into the
/// reader frame's own defaults, and into the plain-text body. Neutral grey with
/// alpha reads on both a white and a dark surface.
export const CODE_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

export const CODE_LOOK = {
  inline: { fontFamily: CODE_FONT, fontSize: '0.9em', backgroundColor: 'rgba(127, 127, 127, 0.18)', borderRadius: '4px', padding: '1px 4px' },
  block: { fontFamily: CODE_FONT, fontSize: '0.9em', backgroundColor: 'rgba(127, 127, 127, 0.14)', borderRadius: '6px', padding: '8px 12px', whiteSpace: 'pre-wrap', overflowX: 'auto' },
  // A <code> inside a <pre>: the block already has the background and padding.
  inBlock: { fontFamily: CODE_FONT },
};

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/// A look as CSS declarations, for a stylesheet.
export const lookCss = (look) => Object.entries(look).map(([k, v]) => `${kebab(k)}: ${v};`).join(' ');
