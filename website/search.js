/* Full-text search for the docs and FAQ hub pages.
 *
 * Both hubs used to filter their own link list, so only the words in a
 * question title were findable — searching the FAQ for `com.mailvault.app`,
 * which appears in an answer, returned nothing. This searches every guide,
 * comparison, blog post and FAQ answer on the site through the generated
 * search-index.json (scripts/build-search-index.mjs), and links straight to
 * the section that matched.
 *
 * Progressive enhancement, twice over: with scripting off the box stays hidden
 * and the static list below is still every page one link away, and if the index
 * cannot be fetched or parsed the box falls back to filtering that same list.
 *
 * Markup contract — on the input:
 *   data-mv-search           marks the field (its parent is unhidden here)
 *   data-index="#id"         the static list, hidden while results are shown
 *   data-heading="#id"       its heading, hidden with it (optional)
 *   data-results="#id"       empty container the results are rendered into
 *   data-empty="#id"         the "nothing matched" message
 *   data-row=".sel"          rows of the static list, for the fallback filter
 *   data-group=".sel"        their group wrappers, hidden when all rows are
 */
(() => {
  const field = document.querySelector('[data-mv-search]');
  if (!field) return;

  const pick = name => document.querySelector(field.dataset[name]);
  const staticIndex = pick('index');
  const results = pick('results');
  const empty = pick('empty');
  const heading = field.dataset.heading ? pick('heading') : null;
  const rows = [...document.querySelectorAll(field.dataset.row)];
  const groups = [...document.querySelectorAll(field.dataset.group)];

  field.parentElement.hidden = false;

  // The hub pages sit at a locale root (/faq.html, /de/docs.html), so the
  // index of the language being read is always next to the page itself.
  const indexUrl = location.pathname.replace(/[^/]*$/, '') + 'search-index.json?v=1';

  let entries = null;   // null = not loaded yet, [] = load failed
  let loading = null;

  const load = () => loading ??= fetch(indexUrl)
    // A missing file on this site answers 200 text/html, so the parse is the
    // real check — never the status code.
    .then(r => r.json())
    .then(data => { entries = Array.isArray(data) ? data : []; })
    .catch(() => { entries = []; });

  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const terms = q => q.toLowerCase().split(/\s+/).filter(Boolean);

  const score = (entry, needles) => {
    const h = entry.h.toLowerCase();
    const t = entry.t.toLowerCase();
    const x = entry.x.toLowerCase();
    let total = 0;
    for (const needle of needles) {
      let points = 0;
      if (h.includes(needle)) points += 8;
      if (t.includes(needle)) points += 3;
      const body = x.split(needle).length - 1;
      if (body) points += Math.min(body, 3);
      if (!points) return 0;
      total += points;
    }
    return total;
  };

  const MARK = '\u0001';
  const ENDMARK = '\u0002';

  /** ~200 characters around the first match, with every term marked. */
  const snippet = (text, needles) => {
    const lower = text.toLowerCase();
    const at = needles.map(n => lower.indexOf(n)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const from = Math.max(0, at - 80);
    let cut = (from ? '\u2026' : '') + text.slice(from, from + 220) + (from + 220 < text.length ? '\u2026' : '');
    // Mark before escaping, so a term like "amp" cannot land inside an entity.
    for (const needle of needles) {
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      cut = cut.replace(re, m => MARK + m + ENDMARK);
    }
    return esc(cut)
      .replaceAll(MARK, '<mark>')
      .replaceAll(ENDMARK, '</mark>');
  };

  const render = needles => {
    const hits = entries
      .map(e => ({ e, s: score(e, needles) }))
      .filter(h => h.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40);

    results.innerHTML = hits.map(({ e }) => `
      <a href="${esc(e.u)}" class="block rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 hover:border-primary-500 transition-colors">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">${esc(e.t)}</p>
        <p class="font-semibold text-slate-900 dark:text-slate-100 mb-1">${e.h ? snippet(e.h, needles) : esc(e.t)}</p>
        ${e.x ? `<p class="text-sm text-slate-600 dark:text-slate-400">${snippet(e.x, needles)}</p>` : ''}
      </a>`).join('');
    return hits.length;
  };

  /** Used only when the index is unreachable: the pre-split behaviour. */
  const filterStatic = needles => {
    let hits = 0;
    for (const row of rows) {
      const text = row.textContent.toLowerCase();
      const match = needles.every(n => text.includes(n));
      row.hidden = !match;
      if (match) hits++;
    }
    for (const group of groups) {
      group.hidden = ![...group.querySelectorAll(field.dataset.row)].some(r => !r.hidden);
    }
    return hits;
  };

  const reset = () => {
    for (const row of rows) row.hidden = false;
    for (const group of groups) group.hidden = false;
    results.hidden = true;
    results.innerHTML = '';
    staticIndex.hidden = false;
    if (heading) heading.hidden = false;
    empty.hidden = true;
  };

  const run = () => {
    const needles = terms(field.value.trim());
    if (!needles.length) return reset();

    if (entries === null) { load().then(run); return; }

    const hits = entries.length ? render(needles) : filterStatic(needles);
    results.hidden = !entries.length;
    staticIndex.hidden = entries.length > 0;
    if (heading) heading.hidden = staticIndex.hidden;
    empty.hidden = hits > 0;
  };

  field.addEventListener('focus', load, { once: true });
  field.addEventListener('input', run);
  if (field.value.trim()) run();
})();
