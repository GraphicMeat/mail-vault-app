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
  const theme = document.querySelector('.mv-theme');
  function labelTheme() {
    if (pageLanguage === 'en') theme?.setAttribute('aria-label', html.classList.contains('dark') ? 'Switch to light theme' : 'Switch to dark theme');
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
  theme?.addEventListener('click', () => {
    html.classList.toggle('dark');
    try { localStorage.theme = html.classList.contains('dark') ? 'dark' : 'light'; } catch { /* preference is optional */ }
    labelTheme();
    syncShots();
  });
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
  if (mobile) document.querySelectorAll('.mv-mobile-device').forEach(el => { el.hidden = false; });
  if (linux) {
    const platform = document.querySelector('[data-platform="linux"]');
    if (platform) platform.parentElement.prepend(platform);
  }
  if (mac || linux) {
    document.querySelectorAll('[data-hero-platform="fallback"]').forEach(el => { el.hidden = true; });
    document.querySelectorAll('[data-hero-platform="' + (mac ? 'mac' : 'linux') + '"]').forEach(el => { el.hidden = false; });
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

  const downloadStatus = document.querySelector('[data-download-status]');
  const downloadControls = document.querySelectorAll('[data-download="mac"], [data-download="amd64"], [data-download="arm64"]');
  if (downloadControls.length) {
    fetch('https://api.github.com/repos/GraphicMeat/mail-vault-app/releases/latest', { signal: AbortSignal.timeout(10000) })
      .then(r => { if (!r.ok) throw new Error('release unavailable'); return r.json(); })
      .then(release => {
        if (!Array.isArray(release.assets)) throw new Error('release unavailable');
        const matches = {
          mac: release.assets.find(a => /\.dmg$/.test(a.name)),
          amd64: release.assets.find(a => /amd64.*\.deb$/.test(a.name)),
          arm64: release.assets.find(a => /arm64.*\.deb$/.test(a.name)),
        };
        let resolved = 0;
        Object.entries(matches).forEach(([platform, asset]) => {
          if (!asset) return;
          const url = new URL(asset.browser_download_url);
          if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/GraphicMeat/mail-vault-app/releases/download/')) return;
          document.querySelectorAll('[data-download="' + platform + '"]').forEach(link => { link.href = url.href; link.dataset.acquisitionResult = 'file'; });
          resolved++;
        });
        if (downloadStatus) downloadStatus.textContent = resolved === 3
          ? (runtimeCopy.releaseReady || 'Latest release: {release}. Direct download links are ready.').replace('{release}', release.tag_name || 'available')
          : (runtimeCopy.releasePartial || 'Some downloads open the latest release page. Choose the file for your computer there.');
      })
      .catch(() => { if (downloadStatus) downloadStatus.textContent = runtimeCopy.releaseFallback || 'Direct links could not load. The download buttons open the latest release page instead; choose the file for your computer there.'; });
  }

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
})();
