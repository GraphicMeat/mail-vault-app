// @vitest-environment jsdom
//
// The first Reply of a session could open "Compose could not open" instead of
// the compose window: `null is not an object (evaluating 'e.cached')` from the
// content-sync effect's getHTML(). Told to build the editor during render,
// @tiptap/react arms a 1 ms timer there that destroys it unless useEditor's
// mount effect has run, and relies on React throwing away a render whose store
// changed meanwhile. Compose resolves through a Suspense retry; when App had
// re-rendered while it loaded, React rendered the revealed tree at a blocking
// lane, which skips that check. The timer fired while the render yielded, and
// React committed the editor it had just destroyed.
//
// The real @tiptap/react runs here. The harness fires the due timer from the
// render phase, after RichTextEditor rendered and before the commit: the gap
// the webview's time-sliced render left open.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useRef } from 'react';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

let settings;
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  return { useSettingsStore: hook };
});

const { RichTextEditor } = await import('../RichTextEditor');

/** What ChunkErrorBoundary would have caught, as text. */
class Caught extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    return this.state.error ? <p role="alert">{this.state.error.message}</p> : this.props.children;
  }
}
const crash = () => screen.queryByRole('alert')?.textContent ?? null;

/** Rendered after RichTextEditor: its first render is the gap between that render and the commit. */
function TimerFiresBeforeCommit() {
  const fired = useRef(false);
  if (!fired.current) {
    fired.current = true;
    vi.advanceTimersByTime(1);
  }
  return null;
}

/** An editorRef that remembers every editor it was handed, and whether it was already destroyed. */
function recordingRef() {
  const handed = [];
  const ref = {
    get current() { return handed.at(-1)?.editor ?? null; },
    set current(editor) { handed.push({ editor, destroyed: !!editor?.isDestroyed }); },
  };
  return { ref, destroyedWhenHanded: () => handed.map((h) => h.destroyed) };
}

beforeEach(() => {
  settings = { spellcheckEnabled: true, setSpellcheckEnabled: vi.fn() };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();   // an unmounted editor is destroyed on a timer
  vi.useRealTimers();
});

describe('RichTextEditor mount', () => {
  it('opens on a live editor when the destroy timer fires before the commit', () => {
    const { ref, destroyedWhenHanded } = recordingRef();
    render(
      <Caught>
        <RichTextEditor content="<p>Hello Ann</p>" onUpdate={() => {}} editorRef={ref} />
        <TimerFiresBeforeCommit />
      </Caught>
    );
    expect(crash()).toBe(null);
    expect(screen.getByRole('textbox').textContent).toBe('Hello Ann');
    // ComposeModal inserts templates and dropped images through this ref.
    expect(destroyedWhenHanded()).not.toContain(true);
    expect(ref.current.isDestroyed).toBe(false);
  });

  // Whatever destroys the instance under this component, its effects must not
  // read HTML off it: TipTap's destroy() nulls the schema getHTML() serializes with.
  it('takes new content on the editor that replaces a destroyed one', () => {
    const { ref } = recordingRef();
    const { rerender } = render(
      <Caught><RichTextEditor content="<p>Hello</p>" onUpdate={() => {}} editorRef={ref} /></Caught>
    );
    ref.current.destroy();
    rerender(<Caught><RichTextEditor content="<p>Signature</p>" onUpdate={() => {}} editorRef={ref} /></Caught>);
    expect(crash()).toBe(null);
    expect(screen.getByRole('textbox').textContent).toBe('Signature');
  });

  it('switches spellcheck without reading a destroyed editor', () => {
    const { ref } = recordingRef();
    const { rerender } = render(
      <Caught><RichTextEditor content="<p>Hello</p>" onUpdate={() => {}} editorRef={ref} /></Caught>
    );
    ref.current.destroy();
    settings.spellcheckEnabled = false;
    rerender(<Caught><RichTextEditor content="<p>Hello</p>" onUpdate={() => {}} editorRef={ref} /></Caught>);
    expect(crash()).toBe(null);
    expect(screen.getByRole('textbox').textContent).toBe('Hello');
  });
});
