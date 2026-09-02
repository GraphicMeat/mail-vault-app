import { describe, it, expect } from 'vitest';
import { sections } from '../build-search-index.mjs';

// The site search is only as good as this extraction: if a markup change makes
// sections() return nothing, the index still builds, the JSON is still valid,
// and every search silently returns no results.
describe('sections', () => {
  it('takes the anchor off the element that encloses the heading', () => {
    const html = `<main>
      <article id="where-are-emails-stored">
        <h2>Where are my emails stored?</h2>
        <p>Your vault lives in <code>~/Library/Containers/com.mailvault.app</code>.</p>
      </article>
    </main>`;

    expect(sections(html)).toEqual([{
      a: 'where-are-emails-stored',
      h: 'Where are my emails stored?',
      x: 'Your vault lives in ~/Library/Containers/com.mailvault.app .',
    }]);
  });

  it('reads an id on the heading itself, and leaves an unanchored one blank', () => {
    const html = `<main>
      <h2 id="first">One</h2><p>alpha</p>
      <h3>Two</h3><p>beta</p>
    </main>`;

    expect(sections(html).map(s => [s.a, s.h, s.x])).toEqual([
      ['first', 'One', 'alpha'],
      ['', 'Two', 'beta'],
    ]);
  });

  it('decodes entities and drops scripts, styles and inline svg', () => {
    const html = `<main>
      <h2>Flags &amp; names</h2>
      <p>Archived &mdash; seen</p>
      <script>const secret = 1;</script>
      <style>.x{color:red}</style>
      <svg><path d="M0 0"/></svg>
    </main>`;

    const [only] = sections(html);
    expect(only.h).toBe('Flags & names');
    expect(only.x).toBe('Archived — seen');
  });

  it('ignores everything outside <main>', () => {
    expect(sections('<body><h2 id="nav">Nav</h2></body>')).toEqual([]);
  });
});
