/* Native links and details keep documentation usable without scripting. With scripting, moving between
   help articles swaps the sidebar and content in place (the pages stay complete static HTML for crawlers
   and for any failure: every swap problem falls back to an ordinary navigation). */
(() => {
  const html = document.documentElement;
  const wide = matchMedia('(min-width:761px)');
  const LAYOUT = '.mv-help-layout';
  // Articles only: the hub pages (docs, faq, blog) carry their own search script, so they load normally.
  const ARTICLE = /^(?:\/(?:de|fr|es|it|ja|ko|zh|pt-br))?\/(?:faq|guides|blog)\/[^/]+\.html$/;

  const syncTopics = () => { const topics = document.querySelector('.mv-help-sidebar'); if (topics) topics.open = wide.matches; };
  wide.addEventListener('change', syncTopics);

  // Screenshots ship a light and a dark set; english-site.js only knows the ones present at load.
  const syncShots = () => {
    const dark = html.classList.contains('dark');
    document.querySelectorAll('picture source[data-shot-dark]').forEach(source => { source.media = dark ? 'all' : 'not all'; });
  };
  new MutationObserver(syncShots).observe(html, { attributes:true, attributeFilter:['class'] });

  const dialog = document.querySelector('.mv-help-lightbox');
  let trigger;
  const openImage = (link, event) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    trigger = link;
    const source = link.querySelector('img');
    let image = dialog.querySelector('img');
    if (!image) {
      image = document.createElement('img');
      dialog.insertBefore(image,dialog.querySelector('p'));
    }
    const picture = source.closest('picture');
    const active = picture && [...picture.querySelectorAll('source')].find(s => s.srcset && (!s.media || matchMedia(s.media).matches));
    const set = active?.srcset || source.srcset;
    image.src = set ? set.split(',').pop().trim().split(/\s+/)[0] : link.href;
    image.alt = source.alt;
    dialog.querySelector('p').textContent = source.alt;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
  };
  if (dialog?.showModal) {
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
    dialog.addEventListener('close', () => { document.body.style.overflow = ''; trigger?.focus(); });
  }

  // Everything that belongs to one rendering of the layout: runs on load and after every swap.
  const init = root => {
    syncTopics();
    const field = root.querySelector('[data-mv-search]');
    if (field) {
      field.value = new URLSearchParams(location.search).get('q') || '';
      root.querySelector('[data-help-clear]')?.addEventListener('click', () => {
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles:true }));
        field.focus();
        history.replaceState(history.state, '', location.pathname + location.hash);
      });
      if (field.value) field.dispatchEvent(new Event('input', { bubbles:true }));
    }
    if (dialog?.showModal) root.querySelectorAll('[data-help-image]').forEach(link => link.addEventListener('click', event => openImage(link, event)));
    syncShots();
  };
  init(document.querySelector(LAYOUT) || document);

  // ---- In-place navigation ----
  if (!window.fetch || !window.DOMParser || !history.pushState || !document.querySelector(LAYOUT)) return;

  const key = url => url.pathname + url.search;
  let current = key(location);
  let token = 0;
  const pages = new Map();
  const load = url => {
    if (!pages.has(url)) {
      pages.set(url, fetch(url, { credentials:'same-origin' })
        .then(response => {
          if (!response.ok || !/html/.test(response.headers.get('content-type') || '')) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then(text => new DOMParser().parseFromString(text, 'text/html'))
        .catch(error => { pages.delete(url); throw error; }));
    }
    return pages.get(url);
  };

  const styleSignature = doc => [...doc.querySelectorAll('link[rel="stylesheet"]')].map(link => link.getAttribute('href')).sort().join('|')
    + '#' + doc.body.className;
  const baseline = styleSignature(document);

  const swappable = doc => !!doc.querySelector(LAYOUT)
    && !doc.querySelector('[data-mv-search-container]')
    && doc.documentElement.lang === html.lang
    && styleSignature(doc) === baseline;

  const copyHead = doc => {
    document.title = doc.title;
    for (const selector of ['meta[name="description"]', 'link[rel="canonical"]', 'meta[property^="og:"]', 'meta[name^="twitter:"]']) {
      document.head.querySelectorAll(selector).forEach(old => old.remove());
      doc.head.querySelectorAll(selector).forEach(next => document.head.append(document.importNode(next, true)));
    }
    document.head.querySelectorAll('link[rel="alternate"][hreflang]').forEach(old => old.remove());
    doc.head.querySelectorAll('link[rel="alternate"][hreflang]').forEach(next => document.head.append(document.importNode(next, true)));
    document.querySelectorAll('script[type="application/ld+json"]').forEach(old => old.remove());
    doc.querySelectorAll('script[type="application/ld+json"]').forEach(next => {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.textContent = next.textContent;
      document.head.append(script);
    });
    // The header is shared and keeps its handlers: only the page-specific link targets and current-page marks move.
    const same = (selector, apply) => {
      const mine = [...document.querySelectorAll(selector)];
      const theirs = [...doc.querySelectorAll(selector)];
      if (mine.length === theirs.length) mine.forEach((node, index) => apply(node, theirs[index]));
    };
    same('.mv-language a[hreflang], .mv-lang a[hreflang], .mv-mobile-menu a[hreflang]', (node, next) => node.setAttribute('href', next.getAttribute('href')));
    same('.mv-navlinks a, .mv-mobile-menu nav a', (node, next) => {
      node.className = next.className;
      if (next.hasAttribute('aria-current')) node.setAttribute('aria-current', next.getAttribute('aria-current')); else node.removeAttribute('aria-current');
    });
  };

  const scrollTo = (url, y) => {
    const target = url.hash && document.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (target) target.scrollIntoView({ behavior:'instant' });
    else window.scrollTo({ top:y || 0, left:0, behavior:'instant' });
  };

  // The scroll position belongs to the history entry on screen, so it is stored as the reader scrolls
  // (by the time a back or forward arrives, the browser is already on the other entry).
  const remember = () => { try { history.replaceState({ ...(history.state || {}), y:window.scrollY }, ''); } catch { /* optional */ } };
  let settle;
  addEventListener('scroll', () => { clearTimeout(settle); settle = setTimeout(remember, 200); }, { passive:true });

  const go = async (url, push, y) => {
    const mine = ++token;
    const layout = document.querySelector(LAYOUT);
    layout.setAttribute('aria-busy', 'true');
    layout.classList.add('mv-help-loading');
    try {
      const doc = await load(key(url));
      if (mine !== token) return;
      if (!swappable(doc)) throw new Error('not swappable');
      copyHead(doc);
      const next = document.importNode(doc.querySelector(LAYOUT), true);
      layout.replaceWith(next);
      if (push) history.pushState({ y:0 }, '', key(url) + url.hash);
      current = key(url);
      init(next);
      scrollTo(url, y);
      const heading = next.querySelector('h1');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll:true }); }
    } catch {
      if (mine !== token) return;
      if (push) location.assign(url.href); else location.reload();
    }
  };

  const target = (link, event) => {
    if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
    if ((link.target && link.target !== '_self') || link.hasAttribute('download')) return null;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !ARTICLE.test(url.pathname) || key(url) === current) return null;
    return url;
  };

  document.addEventListener('click', event => {
    const link = event.target.closest?.(`${LAYOUT} a[href]`);
    const url = link && target(link, event);
    if (!url) return;
    event.preventDefault();
    clearTimeout(settle);
    remember();
    go(url, true);
  });
  const prefetch = event => {
    const link = event.target.closest?.(`${LAYOUT} a[href]`);
    const url = link && target(link, { button:0 });
    if (url) load(key(url)).catch(() => {});
  };
  document.addEventListener('pointerover', prefetch);
  document.addEventListener('focusin', prefetch);
  document.addEventListener('touchstart', prefetch, { passive:true });

  addEventListener('popstate', event => {
    const url = new URL(location.href);
    if (key(url) !== current) go(url, false, event.state?.y);
  });
})();
