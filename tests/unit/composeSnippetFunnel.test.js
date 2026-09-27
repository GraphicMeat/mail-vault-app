// Download modes (H5): a reader shows the index snippet (`_bodyLoading`) while
// a body downloads, and no compose may open on that text. App.jsx is too large
// to render here, so this pins its two seams to the tested helpers:
// setComposeState resolves a snippet through composeStateWithBody
// (replyTarget.test.js), and the `f` shortcut asks the reader first, which
// resolves the body and shows the button busy (EmailViewerSnippet.test.jsx).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const app = readFileSync('src/App.jsx', 'utf8');

describe('App compose hand-offs never open on a snippet', () => {
  it('setComposeState resolves a snippet stand-in before opening compose', () => {
    const start = app.indexOf('const setComposeState = useCallback');
    const fn = app.slice(start, app.indexOf('}, [openCompose]);', start));
    expect(fn).toMatch(/val\.replyTo\?\._bodyLoading/);
    expect(fn).toMatch(/composeStateWithBody\(val, useMailStore\.getState\(\)\)\.then\(openCompose\)/);
  });

  it('the forward shortcut goes through the reader like reply does', () => {
    const start = app.indexOf('forward: () => {');
    const fn = app.slice(start, app.indexOf('},', app.indexOf('setComposeState', start)) + 2);
    expect(fn).toMatch(/openActiveReply\('forward'\)/);
  });
});
