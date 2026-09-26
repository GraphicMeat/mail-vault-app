/* Shared acquisition interactions for English and generated localized pages. */
(() => {
  'use strict';
  const html = document.documentElement;
  const languageLinks = document.querySelectorAll('.mv-language a[hreflang], .mv-lang a[hreflang]');
  const pageLanguage = html.lang || 'en';
  let runtimeCopy = {};
  try { runtimeCopy = JSON.parse(document.querySelector('#mv-runtime-copy')?.textContent || '{}'); } catch { /* defaults keep the page usable */ }
  const runtimeText = (key, fallback) => runtimeCopy[key] || fallback;
  // Explicit localized URLs win. Restore a saved choice on English entry pages
  // only when that page advertises an equivalent translation.
  try {
    const saved = localStorage.getItem('mv-language');
    const alternate = Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]'))
      .find(link => link.hreflang === saved);
    if (pageLanguage === 'en' && saved && saved !== 'en' && alternate) {
      const target = new URL(alternate.href);
      location.replace(target.pathname + location.search + location.hash);
      return;
    }
    if (pageLanguage !== 'en') localStorage.setItem('mv-language', pageLanguage);
  } catch { /* language navigation also works without browser storage */ }
  languageLinks.forEach(link => link.addEventListener('click', () => {
    try { localStorage.setItem('mv-language', link.hreflang); } catch { /* optional preference */ }
  }));
  const query = new URLSearchParams(location.search);
  const selectedPlan = ['free', 'yearly', 'monthly'].includes(query.get('plan')) ? query.get('plan') : 'free';
  try {
    html.classList.toggle('dark', localStorage.theme === 'dark' || (!localStorage.theme && matchMedia('(prefers-color-scheme: dark)').matches));
  } catch { html.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches); }
  // The bar's theme button, plus its twin in the phone menu.
  const themes = document.querySelectorAll('.mv-theme');
  function labelTheme() {
    if (pageLanguage === 'en') themes.forEach(theme => theme.setAttribute('aria-label', html.classList.contains('dark') ? 'Switch to light theme' : 'Switch to dark theme'));
  }
  labelTheme();
  // Screenshots ship in a light and a dark set. `<source media="(prefers-color-
  // scheme: dark)">` gets the first paint right with scripting off; the site's
  // own toggle is a class on <html>, which no media query can see, so once this
  // script knows the answer it overrules the query outright.
  const shotSources = document.querySelectorAll('picture source[data-shot-dark]');
  function syncShots() {
    const dark = html.classList.contains('dark');
    shotSources.forEach(source => { source.media = dark ? 'all' : 'not all'; });
  }
  syncShots();
  themes.forEach(theme => theme.addEventListener('click', () => {
    html.classList.toggle('dark');
    try { localStorage.theme = html.classList.contains('dark') ? 'dark' : 'light'; } catch { /* preference is optional */ }
    labelTheme();
    syncShots();
  }));
  document.querySelectorAll('.mv-navlinks a, .mv-mobile-menu nav a').forEach(link => {
    const target = new URL(link.href);
    if (!target.hash && target.pathname === location.pathname) link.setAttribute('aria-current', 'page');
  });
  const menus = document.querySelectorAll('.mv-language, .mv-mobile-menu');
  menus.forEach(menu => {
    menu.addEventListener('toggle', () => { if (menu.open) menus.forEach(other => { if (other !== menu) other.open = false; }); });
    menu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => { menu.open = false; }));
  });
  document.addEventListener('click', e => menus.forEach(menu => { if (!menu.contains(e.target)) menu.open = false; }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') menus.forEach(menu => { if (menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
  });

  function setBilling(period) {
    document.querySelectorAll('[data-billing-panel]').forEach(el => { el.hidden = el.dataset.billingPanel !== period; });
    const locale = location.pathname.match(/^\/(?:de|fr|es|it|ja|ko|zh|pt-br)(?=\/|$)/)?.[0] || '';
    document.querySelectorAll('[data-premium-cta]').forEach(el => { el.href = locale + '/get-started.html?plan=' + period; });
  }
  document.querySelectorAll('input[name="billing"]').forEach(input => input.addEventListener('change', () => { if (input.checked) setBilling(input.value); }));
  const checked = document.querySelector('input[name="billing"]:checked');
  if (checked) { setBilling(checked.value); document.querySelector('.mv-billing').hidden = false; }
  // URL intent survives refresh/bookmark without storing a visitor identifier.
  // It does not start checkout or imply that the desktop app received the plan.
  document.querySelectorAll('[data-plan-copy]').forEach(el => { el.hidden = el.dataset.planCopy !== selectedPlan; });
  const steps = document.querySelector('#already-installed');
  if (steps && selectedPlan !== 'free' && pageLanguage === 'en') document.title = selectedPlan === 'yearly' ? 'Set up your MailVault yearly trial' : 'Set up MailVault monthly Premium';

  const mobile = /Android|iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const linux = /Linux/.test(navigator.userAgent) && !mobile;
  const mac = /Macintosh|Mac OS X/.test(navigator.userAgent) && !mobile;
  const windows = /Windows NT/.test(navigator.userAgent) && !mobile;
  if (mobile) document.querySelectorAll('.mv-mobile-device').forEach(el => { el.hidden = false; });
  const heroPlatform = mac ? 'mac' : windows ? 'windows' : linux ? 'linux' : '';
  const ownPlatform = heroPlatform && document.querySelector('[data-platform="' + heroPlatform + '"]');
  if (ownPlatform) ownPlatform.parentElement.prepend(ownPlatform);
  if (heroPlatform && document.querySelector('[data-hero-platform="' + heroPlatform + '"]')) {
    document.querySelectorAll('[data-hero-platform="fallback"]').forEach(el => { el.hidden = true; });
    document.querySelectorAll('[data-hero-platform="' + heroPlatform + '"]').forEach(el => { el.hidden = false; });
  }

  // Same anonymous aggregate event as the existing site; no app telemetry or IDs.
  const productionHost = ['mailvaultapp.com', 'www.mailvaultapp.com'].includes(location.hostname);
  const pageVersion = 'homepage-en-20260922';
  function acquisitionEvent(name, properties = {}) {
    if (!productionHost) return;
    try {
      if (!window.gm) {
        const queue = (...args) => { queue.q.push(args); };
        queue.q = [];
        window.gm = queue;
      }
      window.gm(name, { page_version: pageVersion, ...properties });
    } catch { /* navigation must not depend on analytics */ }
  }
  function metric(event) {
    if (!productionHost) return;
    try { navigator.sendBeacon('/api/metrics/e', event); } catch { /* navigation must not depend on metrics */ }
  }
  if (location.pathname === '/pricing.html') metric('pricing_view');
  if (document.body.dataset.acquisitionPage === 'setup') {
    const setupView = () => acquisitionEvent('setup_view', { plan: selectedPlan });
    if (document.readyState === 'complete') setupView();
    else document.addEventListener('DOMContentLoaded', setupView, { once:true });
  }
  document.querySelectorAll('[data-download]').forEach(link => link.addEventListener('click', () => metric('download_click')));
  document.querySelectorAll('[data-acquisition-event]').forEach(link => link.addEventListener('click', () => acquisitionEvent(link.dataset.acquisitionEvent, {
    ...(link.dataset.acquisitionPlacement ? { placement: link.dataset.acquisitionPlacement } : {}),
    ...(link.dataset.acquisitionDestination ? { destination: link.dataset.acquisitionDestination } : {}),
  })));
  document.querySelectorAll('[data-acquisition-download]').forEach(link => link.addEventListener('click', () => acquisitionEvent('download_action', {
    platform: link.dataset.acquisitionDownload,
    destination: link.dataset.acquisitionResult || (link.dataset.acquisitionDownload === 'snap' ? 'store' : 'fallback'),
  })));
  // Every other CTA: named by where it goes, not by its (localized) label.
  const cta = 'a.mv-button, button.mv-button, .mv-text-link, .mv-navlinks a, .mv-mobile-menu nav a, .mv-footer nav a, .mv-community-actions > *, .mv-social';
  document.addEventListener('click', e => {
    const el = e.target.closest?.(cta);
    if (!el || el.matches('[data-acquisition-event], [data-acquisition-download]')) return;
    const href = el.getAttribute('href');
    const url = href && new URL(href, location.href);
    const target = !url ? '#' + (el.id || (el.matches('[data-vote]') ? 'heart' : 'button'))
      : url.origin === location.origin ? url.pathname.replace(/^\/(de|fr|es|it|ja|ko|zh|pt-br)\//, '/') + url.hash
      : url.hostname + url.pathname;
    const placement = el.closest('header') ? 'header' : el.closest('footer') ? 'footer' : el.closest('section[id]')?.id || 'page';
    acquisitionEvent('cta_click', { target, placement });
  });

  // One .deb button for Linux: pick the ARM build when the browser says so.
  if (/aarch64|arm64|armv8/i.test(navigator.userAgent)) document.querySelectorAll('[data-linux-deb]').forEach(link => {
    link.dataset.download = 'arm64';
    link.dataset.acquisitionDownload = 'arm64';
  });
  const downloadStatus = document.querySelector('[data-download-status]');
  const downloadControls = document.querySelectorAll('[data-download="mac"], [data-download="windows"], [data-download="amd64"], [data-download="arm64"]');
  let releaseLinks;
  if (downloadControls.length) {
    releaseLinks = fetch('https://api.github.com/repos/GraphicMeat/mail-vault-app/releases/latest', { signal: AbortSignal.timeout(10000) })
      .then(r => { if (!r.ok) throw new Error('release unavailable'); return r.json(); })
      .then(release => {
        if (!Array.isArray(release.assets)) throw new Error('release unavailable');
        const matches = {
          mac: release.assets.find(a => /\.dmg$/.test(a.name)),
          windows: release.assets.find(a => /-setup\.exe$/.test(a.name)),
          amd64: release.assets.find(a => /amd64.*\.deb$/.test(a.name)),
          arm64: release.assets.find(a => /arm64.*\.deb$/.test(a.name)),
        };
        // Only the platforms this page offers count towards "all links ready".
        const wanted = Object.keys(matches).filter(platform => document.querySelector('[data-download="' + platform + '"]'));
        let resolved = 0;
        Object.entries(matches).forEach(([platform, asset]) => {
          if (!asset || !wanted.includes(platform)) return;
          const url = new URL(asset.browser_download_url);
          if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/GraphicMeat/mail-vault-app/releases/download/')) return;
          // A [data-download-page] button leads to a page that starts the download itself.
          document.querySelectorAll('[data-download="' + platform + '"]:not([data-download-page])').forEach(link => { link.href = url.href; link.dataset.acquisitionResult = 'file'; });
          resolved++;
        });
        if (downloadStatus) downloadStatus.textContent = resolved === wanted.length
          ? (runtimeCopy.releaseReady || 'Latest release: {release}. Direct download links are ready.').replace('{release}', release.tag_name || 'available')
          : (runtimeCopy.releasePartial || 'Some downloads open the latest release page. Choose the file for your computer there.');
      })
      .catch(() => { if (downloadStatus) downloadStatus.textContent = runtimeCopy.releaseFallback || 'Direct links could not load. The download buttons open the latest release page instead; choose the file for your computer there.'; });
    // A click that beats the release lookup waits briefly for the direct file
    // instead of dropping the visitor on the release page.
    downloadControls.forEach(link => link.addEventListener('click', e => {
      if (link.dataset.acquisitionResult === 'file' || link.hasAttribute('data-download-page') || link.target === '_blank') return;
      e.preventDefault();
      Promise.race([releaseLinks, new Promise(resolve => setTimeout(resolve, 4000))]).then(() => location.assign(link.href));
    }));
    // The Windows download page starts its installer when reached from a download button.
    const autoDownload = document.querySelector('[data-auto-download]');
    if (autoDownload && query.has('start')) {
      try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* a reload may download again */ }
      // Clicking the button itself records the download like a visitor's click would.
      releaseLinks.then(() => { if (autoDownload.dataset.acquisitionResult === 'file') autoDownload.click(); });
    }
  }

  // Homepage proof line: installer downloads across all releases, counted and
  // cached hourly by the site's API. Rounded down so it reads as a floor.
  const downloadTotals = document.querySelectorAll('[data-download-total]');
  if (downloadTotals.length) {
    fetch('/api/downloads', { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const total = data.installers;
        if (!Number.isInteger(total) || total < 100) return;
        const step = 10 ** Math.max(2, Math.floor(Math.log10(total)) - 1);
        const floor = Math.floor(total / step) * step;
        downloadTotals.forEach(node => { node.textContent = floor.toLocaleString(pageLanguage) + '+'; });
        document.querySelectorAll('[data-download-proof]').forEach(el => { el.hidden = false; });
      }).catch(() => {});
  }

  // GitHub stars and hearts in the header. The homepage's community section
  // loads the same counts, so this only fetches where that section is absent.
  const countNodes = (name) => document.querySelectorAll('[data-' + name + '], #' + name);
  function showCount(name, value) {
    if (!Number.isInteger(value) || value < 0) return;
    countNodes(name).forEach(node => { node.textContent = value.toLocaleString(pageLanguage); node.hidden = false; });
  }
  const voteButtons = document.querySelectorAll('[data-vote]');
  let voted = false;
  try { voted = localStorage.getItem('mailvault-voted') === 'true'; } catch { /* hearts still work without storage */ }
  const reflectVote = () => voteButtons.forEach(button => button.setAttribute('aria-pressed', String(voted)));
  reflectVote();
  if (voteButtons.length && !document.getElementById('want-this-btn')) {
    // Unauthenticated GitHub API calls are capped per visitor, so reuse the
    // star count for the session instead of asking on every page.
    let stars = NaN;
    try { stars = Number(sessionStorage.getItem('mv-github-stars')); } catch { /* optional cache */ }
    if (stars > 0) showCount('github-stars', stars);
    else fetch('https://api.github.com/repos/GraphicMeat/mail-vault-app', { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(repo => {
        showCount('github-stars', repo.stargazers_count);
        try { sessionStorage.setItem('mv-github-stars', String(repo.stargazers_count)); } catch { /* optional cache */ }
      }).catch(() => {});
    fetch('/api/votes').then(r => r.ok ? r.json() : Promise.reject()).then(data => showCount('vote-count', data.count)).catch(() => {});
  }
  voteButtons.forEach(button => button.addEventListener('click', async () => {
    if (voted || button.disabled) return;
    voteButtons.forEach(b => { b.disabled = true; });
    try {
      const response = await fetch('/api/votes', { method: 'POST', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('vote failed');
      const data = await response.json();
      showCount('vote-count', data.count);
      voted = true;
      try { localStorage.setItem('mailvault-voted', 'true'); } catch { /* counted server-side anyway */ }
      reflectVote();
    } catch { /* the heart stays unpressed so the visitor can try again */ }
    finally { voteButtons.forEach(b => { b.disabled = false; }); }
  }));

  const dialog = document.querySelector('.mv-lightbox');
  let previousFocus;
  document.querySelectorAll('[data-image]').forEach(button => button.addEventListener('click', () => {
    const source = button.querySelector('img');
    previousFocus = button;
    const image = dialog.querySelector('img');
    // The thumbnail may be the light or the dark candidate. Reading the img's
    // own srcset would enlarge the light shot over a dark page, so ask the
    // <picture> which source is actually matching right now.
    const picture = source.closest('picture');
    const active = picture && [...picture.querySelectorAll('source')]
      .find((candidate) => candidate.srcset && (!candidate.media || matchMedia(candidate.media).matches));
    const set = (active && active.srcset) || source.srcset;
    image.src = set.split(',').pop().trim().split(/\s+/)[0] || source.src;
    image.alt = source.alt;
    dialog.querySelector('p').textContent = source.alt;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
  }));
  dialog?.querySelector('[data-close-image]').addEventListener('click', () => dialog.close());
  dialog?.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
  dialog?.addEventListener('close', () => { document.body.style.overflow = ''; previousFocus?.focus(); });

  document.querySelectorAll('[data-subscribe]').forEach(form => {
    const status = form.querySelector('[data-form-status]');
    if (query.has('subscribed')) status.textContent = runtimeText('newsletterSubscribed', 'You’re on the list. Watch for the welcome email.');
    if (query.has('subscribe_error')) status.textContent = runtimeText('newsletterQueryError', 'That did not go through. Check your email address and try again.');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const button = form.querySelector('[type="submit"]');
      if (button.disabled) return;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = runtimeText('newsletterSubmitting', 'Subscribing…');
      button.setAttribute('aria-busy', 'true');
      status.textContent = '';
      try {
        if (!navigator.onLine) throw new Error(runtimeText('newsletterOffline', 'You appear to be offline. Reconnect and try again.'));
        const response = await fetch(form.action, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:form.elements.email.value}), signal:AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(response.status === 429 ? runtimeText('newsletterRateLimit', 'Too many attempts. Wait a minute and try again.') : runtimeText('newsletterSaveError', 'We could not save your email. Please try again in a moment.'));
        status.textContent = runtimeText('newsletterSubscribed', 'You’re on the list. Watch for the welcome email.');
        form.reset();
      } catch (error) {
        status.textContent = error.name === 'TypeError' || error.name === 'TimeoutError' ? runtimeText('newsletterReachError', 'We could not reach the server. Check your connection and try again.') : error.message;
      } finally { button.disabled = false; button.textContent = label; button.removeAttribute('aria-busy'); }
    });
  });
  // Feature videos: a section stays hidden until its YouTube id is filled in, and
  // nothing is requested from YouTube until the visitor presses play.
  document.querySelectorAll('.fp-video[data-youtube-id]').forEach(box => {
    const id = box.dataset.youtubeId;
    const play = box.querySelector('.fp-play');
    if (!/^[\w-]{11}$/.test(id) || !play) return;
    box.hidden = false;
    play.addEventListener('click', () => {
      const frame = document.createElement('iframe');
      frame.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0';
      frame.title = box.getAttribute('aria-label') || 'Video';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      frame.allowFullscreen = true;
      play.replaceWith(frame);
    }, { once: true });
  });
})();
