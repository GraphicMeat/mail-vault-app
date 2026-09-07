// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getEmailBodyContent,
  measureCollapsedEmailIframeHeight,
  attachEmailIframeAutoSize,
  stripInlineColorImportant,
  neutralizeEmailDarkScheme,
  buildEmailIframeHtml,
} from '../emailIframeTemplate';

describe('getEmailBodyContent', () => {
  it('unwraps a real document', () => {
    const html = '<!DOCTYPE html><html><head></head><body><p>hi</p></body></html>';
    expect(getEmailBodyContent(html)).toBe('<p>hi</p>');
  });

  it('keeps the sender text when the quote embeds a whole document', () => {
    // Our own reply: fragment + <blockquote> holding Proton's full document.
    const html = '<p>Hello again</p><hr><blockquote><html><head></head><body>That would be awesome.</body></html></blockquote>';
    expect(getEmailBodyContent(html)).toContain('Hello again');
  });

  it('does not truncate a document at a nested </body>', () => {
    const html = '<html><body><p>mine</p><blockquote><body>quoted</body></blockquote><p>tail</p></body></html>';
    const out = getEmailBodyContent(html);
    expect(out).toContain('mine');
    expect(out).toContain('tail');
  });

  it('passes fragments through', () => {
    expect(getEmailBodyContent('<p>plain</p>')).toBe('<p>plain</p>');
    expect(getEmailBodyContent('')).toBe('');
  });
});

describe('stripInlineColorImportant', () => {
  it('drops the priority from colour declarations', () => {
    // The newsletter shape that rendered black-on-black in dark mode.
    const html = '<h2 style="color:hsl(0, 0%, 0%) !important; font-size:1.3em !important;">Hi</h2>';
    const out = stripInlineColorImportant(html);
    expect(out).toContain('color:hsl(0, 0%, 0%);');
    expect(out).toContain('font-size:1.3em !important;');
  });

  it('covers the other colour properties Dark Reader overrides', () => {
    const html = '<td style="background-color:#fff !important;border-top-color:#ccc !important;'
      + 'background:#eee !important;fill:#000 !important;outline-color:red !important">x</td>';
    const out = stripInlineColorImportant(html);
    expect(out).not.toContain('!important');
  });

  it('leaves layout and typography priorities alone', () => {
    const html = '<div style="width:100% !important;padding:0 !important;display:block !important">x</div>';
    expect(stripInlineColorImportant(html)).toBe(html);
  });

  it('handles single-quoted style attributes and last declarations', () => {
    const html = "<p style='margin:0 !important;color:#000 !important'>x</p>";
    expect(stripInlineColorImportant(html)).toBe("<p style='margin:0 !important;color:#000'>x</p>");
  });

  it('passes through bodies with nothing to strip', () => {
    const html = '<p style="color:#000">x</p><p>plain</p>';
    expect(stripInlineColorImportant(html)).toBe(html);
    expect(stripInlineColorImportant('')).toBe('');
  });
});

describe('neutralizeEmailDarkScheme', () => {
  // `color-scheme: light` does NOT stop `@media (prefers-color-scheme: dark)`
  // from matching — that query reads the OS appearance, and inside the frame it
  // was true on every dark Mac. A newsletter that flips only its BACKGROUNDS in
  // dark mode then painted itself black under its own black text.
  it('makes a dark-scheme block unmatchable while keeping its declarations', () => {
    const html = '<style>@media (prefers-color-scheme: dark){.card{background:#171717 !important;}}</style><p>hi</p>';
    const out = neutralizeEmailDarkScheme(html);
    expect(out).not.toMatch(/prefers-color-scheme\s*:\s*dark/i);
    expect(out).toContain('background:#171717 !important');
    expect(out).toContain('<p>hi</p>');
  });

  it('leaves a light-scheme query alone — the baseline IS light', () => {
    const html = '<style>@media (prefers-color-scheme: light){.card{background:#fff;}}</style>';
    expect(neutralizeEmailDarkScheme(html)).toContain('prefers-color-scheme: light');
  });

  it('catches the spacing and casing an ESP actually ships', () => {
    const html = '<style>@media(prefers-color-scheme:dark){a{color:#fff}}'
      + '@media screen and (PREFERS-COLOR-SCHEME : DARK){b{color:#fff}}'
      + '@media (prefers-color-scheme:dark),print{c{color:#fff}}</style>';
    const out = neutralizeEmailDarkScheme(html);
    expect(out).not.toMatch(/prefers-color-scheme\s*:\s*dark/i);
    // The rest of each prelude survives, so `print` still prints.
    expect(out).toContain('screen and');
    expect(out).toContain(',print');
  });

  it('catches the query in a <style media> attribute too', () => {
    const html = '<style media="(prefers-color-scheme: dark)">.card{background:#171717;}</style>';
    const out = neutralizeEmailDarkScheme(html);
    expect(out).not.toMatch(/prefers-color-scheme\s*:\s*dark/i);
    expect(out).toContain('background:#171717');
  });

  it('does not rewrite the words in a mail that TALKS about dark mode', () => {
    const html = '<p>Use @media (prefers-color-scheme: dark) in your CSS.</p>';
    expect(neutralizeEmailDarkScheme(html)).toBe(html);
  });

  it('passes through a body with no stylesheet', () => {
    expect(neutralizeEmailDarkScheme('<p>plain</p>')).toBe('<p>plain</p>');
    expect(neutralizeEmailDarkScheme('')).toBe('');
  });
});

describe('buildEmailIframeHtml dark-scheme suppression', () => {
  const mail = '<style>@media (prefers-color-scheme: dark){body{background:#0d0d0d !important;}}</style>'
    + '<p style="color:#0d0d0d">Sara Choi</p>';

  // Dark Reader is the single source of truth for dark mode, so the email's own
  // dark variant must not fire under it either.
  it('suppresses it in dark mode', () => {
    expect(buildEmailIframeHtml({ bodyHtml: mail, themeTag: 'dark' }))
      .not.toMatch(/prefers-color-scheme\s*:\s*dark/i);
  });

  // The screenshot case: app dark, email rendered LIGHT, no Dark Reader. The
  // mail's own dark block painted the body black under its black text.
  it('suppresses it in light mode', () => {
    expect(buildEmailIframeHtml({ bodyHtml: mail, themeTag: 'light' }))
      .not.toMatch(/prefers-color-scheme\s*:\s*dark/i);
  });

  it('keeps our own light baseline declarations', () => {
    const out = buildEmailIframeHtml({ bodyHtml: mail, themeTag: 'light' });
    expect(out).toContain('color-scheme: light');
    expect(out).toContain('background: #ffffff');
  });
});

describe('buildEmailIframeHtml colour priorities', () => {
  const body = '<h2 style="color:#000 !important">Hi</h2>';

  it('strips them when Dark Reader will run', () => {
    expect(buildEmailIframeHtml({ bodyHtml: body, themeTag: 'dark' }))
      .toContain('style="color:#000"');
  });

  it('leaves the body untouched in light mode', () => {
    expect(buildEmailIframeHtml({ bodyHtml: body, themeTag: 'light' })).toContain(body);
  });
});

describe('measureCollapsedEmailIframeHeight', () => {
  const fakeDoc = (bodyHeight, rootHeight, rootScroll = rootHeight) => ({
    body: {
      scrollHeight: bodyHeight,
      offsetHeight: bodyHeight,
      getBoundingClientRect: () => ({ height: bodyHeight }),
    },
    documentElement: {
      scrollHeight: rootScroll,
      offsetHeight: rootHeight,
      getBoundingClientRect: () => ({ height: rootHeight }),
    },
  });

  it('reads the root box, not the body box', () => {
    // The real numbers from a mail carrying `body { margin: 0; padding: 0 }`:
    // the first paragraph's margin collapsed straight through the body and out
    // of its box, leaving 28px of document outside a body-box measure — and a
    // scrollbar inside the reading pane's scrollbar.
    expect(measureCollapsedEmailIframeHeight(fakeDoc(1498, 1526))).toBe(1526);
  });

  it('takes the tallest of the three root readings', () => {
    // Content that overflows the root box shows up in scrollHeight only.
    expect(measureCollapsedEmailIframeHeight(fakeDoc(200, 232, 900))).toBe(900);
  });

  it('rounds a sub-pixel box up', () => {
    expect(measureCollapsedEmailIframeHeight(fakeDoc(200, 232.4))).toBe(233);
  });

  it('returns 0 for a missing document or root', () => {
    expect(measureCollapsedEmailIframeHeight(null)).toBe(0);
    expect(measureCollapsedEmailIframeHeight({})).toBe(0);
  });
});

describe('attachEmailIframeAutoSize', () => {
  // A fake same-origin iframe. jsdom lies about iframe layout, so the frame,
  // its document and the observer are all injected — this exercises the
  // helper's own logic, not the browser's.
  //
  // The document's boxes are FUNCTIONS of the frame's current height, which is
  // the whole point: that is what a real one is, and measuring it at the
  // height we just wrote is the bug under test.
  const makeIframe = (contentHeight, {
    contentWindow = { id: 'own' },
    // Root box minus body box: the html padding, plus any child margin that
    // collapsed out through the body.
    rootExtra = 0,
    // `html, body { height: 100% }` — the body fills the frame whenever the
    // frame is taller than the content.
    viewportBound = false,
    startHeight = '',
    // Deliver the observer synchronously while the measure is reading, the
    // way a re-entrant callback would.
    fireObserverOnRead = false,
  } = {}) => {
    const writes = [];
    const sawFrameHeight = [];
    const state = { contentHeight };
    const frameHeight = () => parseFloat(iframe.style.height) || 0;
    const bodyHeight = () => (viewportBound
      ? Math.max(state.contentHeight, frameHeight())
      : state.contentHeight);
    const rootHeight = () => bodyHeight() + rootExtra;
    const readRoot = () => {
      sawFrameHeight.push(iframe.style.height);
      if (fireObserverOnRead) observers.forEach((o) => o.targets.length && o.fire());
      return rootHeight();
    };
    const doc = {
      body: {
        get scrollHeight() { return bodyHeight(); },
        get offsetHeight() { return bodyHeight(); },
        getBoundingClientRect: () => ({ height: bodyHeight() }),
      },
      documentElement: {
        get scrollHeight() { return readRoot(); },
        get offsetHeight() { return rootHeight(); },
        getBoundingClientRect: () => ({ height: rootHeight() }),
      },
    };
    const listeners = {};
    const iframe = {
      style: {
        _h: startHeight,
        get height() { return this._h; },
        set height(v) { this._h = v; writes.push(v); },
      },
      contentDocument: doc,
      contentWindow,
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
      removeEventListener: (type, fn) => {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
      },
      _fire: (type) => (listeners[type] || []).forEach((f) => f()),
      _listenerCount: (type) => (listeners[type] || []).length,
      _doc: doc,
      _writes: writes,
      _sawFrameHeight: sawFrameHeight,
      _setContent: (h) => { state.contentHeight = h; },
    };
    return iframe;
  };

  let observers;
  let winListeners;
  let realRO;
  let realAdd;
  let realRemove;

  beforeEach(() => {
    observers = [];
    winListeners = [];
    realRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb) {
        this.cb = cb;
        this.targets = [];
        this.disconnected = false;
        observers.push(this);
      }
      observe(el) { this.targets.push(el); }
      disconnect() { this.disconnected = true; }
      // Deliver a resize the way the browser would: only for a target that
      // was actually observed, or an unobserved body would "resize" too.
      fire() {
        if (!this.targets.length) throw new Error('nothing was observed');
        this.cb(this.targets.map((target) => ({ target })), this);
      }
    };
    realAdd = window.addEventListener;
    realRemove = window.removeEventListener;
    window.addEventListener = (type, fn) => {
      if (type === 'message') winListeners.push(fn); else realAdd.call(window, type, fn);
    };
    window.removeEventListener = (type, fn) => {
      if (type === 'message') winListeners = winListeners.filter((f) => f !== fn);
      else realRemove.call(window, type, fn);
    };
  });

  afterEach(() => {
    globalThis.ResizeObserver = realRO;
    window.addEventListener = realAdd;
    window.removeEventListener = realRemove;
  });

  it('sizes the frame to its content plus padding on attach', () => {
    const iframe = makeIframe(420);
    attachEmailIframeAutoSize(iframe, { minHeight: 300 });
    expect(iframe.style.height).toBe('428px');
  });

  it('collapses the frame before it measures, then writes a real height', () => {
    const iframe = makeIframe(420, { startHeight: '600px' });
    attachEmailIframeAutoSize(iframe, { minHeight: 300 });
    // What the document was asked its height at: 1px, never 600px.
    expect(iframe._sawFrameHeight).toEqual(['1px']);
    expect(iframe._writes).toEqual(['1px', '428px']);
  });

  it('does not grow a body that is sized against the frame', () => {
    // `<style>html,body{height:100%}</style>` is standard email boilerplate.
    // Measured at the frame's own height, every observer tick read back the
    // number we had just written and added `pad` again: 617, 625, 633, … in
    // the real app, climbing for as long as the message stayed open.
    const iframe = makeIframe(500, { viewportBound: true, startHeight: '617px' });
    attachEmailIframeAutoSize(iframe, { minHeight: 300 });
    expect(iframe.style.height).toBe('508px');
    for (let i = 0; i < 6; i++) observers[0].fire();
    expect(iframe.style.height).toBe('508px');
  });

  it('sizes to the root box, not the body box', () => {
    // A mail shipping `body { margin: 0; padding: 0 }` lets its first
    // paragraph's margin collapse out of the body box, and the template's own
    // inset sits half on `html`. Both are outside a body-box measure.
    const iframe = makeIframe(1498, { rootExtra: 28 });
    attachEmailIframeAutoSize(iframe, { minHeight: 300 });
    expect(iframe.style.height).toBe('1534px');
  });

  it('ignores its own observer while it is collapsed to measure', () => {
    // The collapse resizes the observed body. A delivery that re-entered the
    // measure would read the document at 1px, collapse again, and never stop.
    const iframe = makeIframe(420, { fireObserverOnRead: true });
    expect(() => attachEmailIframeAutoSize(iframe, { minHeight: 300 })).not.toThrow();
    expect(iframe.style.height).toBe('428px');
    expect(iframe._writes).toEqual(['1px', '428px']);
  });

  it('floors at the caller min-height', () => {
    const iframe = makeIframe(40);
    attachEmailIframeAutoSize(iframe, { minHeight: 300 });
    expect(iframe.style.height).toBe('300px');
    const thread = makeIframe(40);
    attachEmailIframeAutoSize(thread, { minHeight: 100 });
    expect(thread.style.height).toBe('100px');
  });

  it('follows content that grows after load — the nested-scroller bug', () => {
    // A large image finishing decode seconds after the last timer left the
    // frame shorter than its document, so the frame scrolled inside the pane.
    const iframe = makeIframe(400);
    attachEmailIframeAutoSize(iframe, { minHeight: 300 });
    expect(iframe.style.height).toBe('408px');

    expect(observers[0].targets).toContain(iframe._doc.body);
    iframe._setContent(1800);
    observers[0].fire();
    expect(iframe.style.height).toBe('1808px');
  });

  it('shrinks again when content collapses', () => {
    const iframe = makeIframe(1800);
    attachEmailIframeAutoSize(iframe, { minHeight: 300 });
    iframe._setContent(500);
    observers[0].fire();
    expect(iframe.style.height).toBe('508px');
  });

  it('re-observes the new document when the frame loads another body', () => {
    const iframe = makeIframe(400);
    attachEmailIframeAutoSize(iframe, { minHeight: 300 });
    const first = observers[0];
    iframe._setContent(900);
    iframe._fire('load');
    expect(first.disconnected).toBe(true);
    expect(iframe.style.height).toBe('908px');
  });

  it('ignores an iframe-resize message from another frame', () => {
    // Thread view mounts one frame per message. Applying any frame's fold
    // message to this one resized the wrong messages.
    const iframe = makeIframe(400, { contentWindow: { id: 'mine' } });
    attachEmailIframeAutoSize(iframe, { minHeight: 100 });
    iframe._setContent(900);
    winListeners.forEach((fn) => fn({
      source: { id: 'someone-else' },
      data: { type: 'iframe-resize', height: 5000 },
    }));
    expect(iframe.style.height).toBe('408px');
  });

  it('re-measures on its own frame\'s iframe-resize, ignoring the reported height', () => {
    // The fold script reports its own body box, taken at the frame's current
    // height — a number with the same two blind spots. Measure it ourselves.
    const own = { id: 'mine' };
    const iframe = makeIframe(400, { contentWindow: own });
    attachEmailIframeAutoSize(iframe, { minHeight: 100 });
    iframe._setContent(900);
    winListeners.forEach((fn) => fn({
      source: own,
      data: { type: 'iframe-resize', height: 5000 },
    }));
    expect(iframe.style.height).toBe('908px');
  });

  it('disconnects the observer and drops both listeners on cleanup', () => {
    const iframe = makeIframe(400);
    const detach = attachEmailIframeAutoSize(iframe, { minHeight: 300 });
    expect(winListeners.length).toBe(1);
    expect(iframe._listenerCount('load')).toBe(1);
    detach();
    expect(observers[0].disconnected).toBe(true);
    expect(winListeners.length).toBe(0);
    expect(iframe._listenerCount('load')).toBe(0);
  });

  it('survives a frame whose document is not reachable', () => {
    const iframe = makeIframe(400);
    Object.defineProperty(iframe, 'contentDocument', {
      get() { throw new Error('cross-origin'); },
    });
    expect(() => attachEmailIframeAutoSize(iframe, { minHeight: 300 })()).not.toThrow();
  });
});
