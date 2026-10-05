// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { isChildWindow } from '../isChildWindow';

const at = (search) => window.history.replaceState({}, '', `/app.html${search}`);
afterEach(() => at(''));

describe('isChildWindow', () => {
  // A child window must not write the shared settings and privacy files: it
  // holds a partial copy and would overwrite the owner's state.
  it.each(['compose', 'original', 'settings', 'social', 'export'])('is a child window for ?%s=', (kind) => {
    at(`?${kind}=tok-1`);
    expect(isChildWindow()).toBe(true);
  });

  it('is not one for the main window', () => {
    at('');
    expect(isChildWindow()).toBe(false);
  });
});
