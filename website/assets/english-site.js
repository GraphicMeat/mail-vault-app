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
  // Product Hunt launch day is 4 Oct 2026, 00:01 to 24:00 Pacific (PDT, UTC-7);
  // the bar shows from 30 minutes before to 30 minutes after it, timed by the
  // server's clock (the response Date header), not the visitor's.
  // `?ph=1` previews it on any day.
  const phStart = Date.UTC(2026, 9, 4, 6, 31);
  const phEnd = Date.UTC(2026, 9, 5, 7, 30);
  const phPreview = query.get('ph') === '1';
  const header = document.querySelector('.mv-header');
  function showPh() {
    const phCopy = {
      en: ['MailVault is live on Product Hunt today', 'Support us', 'Close'],
      de: ['MailVault ist heute live auf Product Hunt', 'Unterstützen', 'Schließen'],
      fr: ['MailVault est en ligne sur Product Hunt aujourd’hui', 'Nous soutenir', 'Fermer'],
      es: ['MailVault está hoy en Product Hunt', 'Apóyanos', 'Cerrar'],
      it: ['MailVault è su Product Hunt oggi', 'Sostienici', 'Chiudi'],
      ja: ['MailVault が本日 Product Hunt に登場', '応援する', '閉じる'],
      ko: ['MailVault가 오늘 Product Hunt에 출시되었습니다', '응원하기', '닫기'],
      zh: ['MailVault 今天登陆 Product Hunt', '支持我们', '关闭'],
      pt: ['MailVault está no Product Hunt hoje', 'Apoie-nos', 'Fechar'],
    }[pageLanguage.slice(0, 2)] || [];
    const [phText = 'MailVault is live on Product Hunt today', phAction = 'Support us', phClose = 'Close'] = phCopy;
    const banner = document.createElement('a');
    banner.className = 'mv-ph-banner';
    banner.href = 'https://www.producthunt.com/products/mailvault';
    banner.target = '_blank';
    banner.rel = 'noopener';
    banner.dataset.acquisitionEvent = 'ph_banner';
    banner.dataset.acquisitionPlacement = 'top_bar';
    banner.dataset.acquisitionDestination = 'product_hunt';
    banner.setAttribute('aria-label', `${phText}. ${phAction}`);
    const artwork = document.createElement('img');
    artwork.src = '/assets/product-hunt-pixel-kitten.webp';
    artwork.width = 40;
    artwork.height = 40;
    artwork.alt = '';
    artwork.decoding = 'async';
    const text = document.createElement('span');
    text.className = 'mv-ph-text';
    // Keep the product name still, including where translations place it mid-sentence.
    phText.split(/(MailVault)/).forEach(part => {
      if (!part) return;
      const segment = document.createElement('span');
      segment.className = part === 'MailVault' ? 'mv-ph-name' : 'mv-ph-moving-text';
      segment.textContent = part;
      text.append(segment);
    });
    const action = document.createElement('span');
    action.className = 'mv-ph-action';
    action.textContent = `${phAction} ↗`;
    banner.append(artwork, text, action);
    header.before(banner);
    // The retro kitten card pops over the page once per visitor on launch day.
    // `?ph=1` shows it on every load so the preview always has it.
    let phSeen = false;
    try { phSeen = query.get('ph') !== '1' && localStorage.getItem('mv-ph-overlay') === '2026-10-04'; } catch { /* show it */ }
    const overlay = document.createElement('dialog');
    overlay.className = 'mv-ph-overlay';
    overlay.setAttribute('aria-label', phText);
    const card = banner.cloneNode(false);
    card.className = 'mv-ph-card';
    card.dataset.acquisitionPlacement = 'overlay';
    const cardArt = document.createElement('img');
    cardArt.width = 1760;
    cardArt.height = 587;
    cardArt.alt = `${phText}. ${phAction}`;
    card.append(cardArt);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mv-ph-close';
    close.setAttribute('aria-label', phClose);
    close.textContent = '×';
    overlay.append(close, card);
    document.body.append(overlay);
    close.addEventListener('click', () => overlay.close());
    card.addEventListener('click', () => overlay.close());
    overlay.addEventListener('click', event => { if (event.target === overlay) overlay.close(); });
    overlay.addEventListener('close', () => {
      try { localStorage.setItem('mv-ph-overlay', '2026-10-04'); } catch { /* shows again next visit */ }
    });
    if (!phSeen) setTimeout(() => {
      if (document.querySelector('dialog[open]')) return;
      cardArt.src = '/assets/product-hunt-retro-kitten.webp';
      overlay.showModal();
      close.focus();
    }, 1200);
    // Added after the page's tracking ran, so it binds its own.
    [banner, card].forEach(link => link.addEventListener('click', () => acquisitionEvent('ph_banner', {
      placement: link.dataset.acquisitionPlacement,
      destination: 'product_hunt',
    })));
    return () => { banner.remove(); overlay.close(); overlay.remove(); };
  }
  // Ask the server only within two days of the window, so other days cost no request.
  const phNear = Date.now() > phStart - 1728e5 && Date.now() < phEnd + 1728e5;
  if (header && phPreview) setTimeout(showPh);
  else if (header && phNear) {
    fetch(location.pathname, { method: 'HEAD', cache: 'no-store' })
      .then(response => Date.parse(response.headers.get('date')))
      .catch(() => NaN)
      .then(serverNow => {
        // Any page left open keeps the server's clock and flips on and off by itself.
        const offset = Number.isFinite(serverNow) ? serverNow - Date.now() : 0;
        const now = Date.now() + offset;
        if (now >= phEnd) return;
        setTimeout(() => {
          const hide = showPh();
          setTimeout(hide, phEnd - (Date.now() + offset));
        }, Math.max(0, phStart - now));
      });
  }
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

  const locale = location.pathname.match(/^\/(?:de|fr|es|it|ja|ko|zh|pt-br)(?=\/|$)/)?.[0] || '';
  function setBilling(period) {
    document.querySelectorAll('[data-billing-panel]').forEach(el => { el.hidden = el.dataset.billingPanel !== period; });
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

  // Phones and tablets, iPadOS included: it reports a Mac user agent but has touch points.
  const mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const linux = /Linux/.test(navigator.userAgent) && !mobile;
  const mac = /Macintosh|Mac OS X/.test(navigator.userAgent) && !mobile;
  const windows = /Windows NT/.test(navigator.userAgent) && !mobile;
  if (mobile) document.querySelectorAll('.mv-mobile-device').forEach(el => { el.hidden = false; });
  // A phone cannot run MailVault, so the homepage offers to email the link
  // instead (data-hero-platform="mobile"). Pages without that offer keep the fallback.
  const heroPlatform = mobile ? 'mobile' : mac ? 'mac' : windows ? 'windows' : linux ? 'linux' : '';
  const ownPlatform = heroPlatform && document.querySelector('[data-platform="' + heroPlatform + '"]');
  if (ownPlatform) ownPlatform.parentElement.prepend(ownPlatform);
  if (heroPlatform && document.querySelector('[data-hero-platform="' + heroPlatform + '"]')) {
    document.querySelectorAll('[data-hero-platform="fallback"]').forEach(el => { el.hidden = true; });
    document.querySelectorAll('[data-hero-platform="' + heroPlatform + '"]').forEach(el => { el.hidden = false; });
  }
  // One .deb button for Linux: pick the ARM build when the browser says so.
  const arm = /aarch64|arm64|armv8/i.test(navigator.userAgent);
  if (arm) document.querySelectorAll('[data-linux-deb]').forEach(link => {
    link.dataset.download = 'arm64';
    link.dataset.acquisitionDownload = 'arm64';
  });
  const installers = ['mac', 'windows', 'amd64', 'arm64'];
  const autoDownload = document.querySelector('[data-auto-download]');
  if (autoDownload) {
    // The thank-you page takes its installer from the button that sent the visitor here.
    const platform = query.get('platform');
    if (installers.includes(platform)) autoDownload.dataset.download = autoDownload.dataset.acquisitionDownload = platform;
    const steps = { mac: 'mac', windows: 'windows', amd64: 'linux', arm64: 'linux' }[autoDownload.dataset.download];
    if (steps) document.querySelectorAll('[data-install]').forEach(el => { el.hidden = el.dataset.install !== steps; });
  } else {
    // Every installer button, the bar's Download included, goes through the
    // thank-you page: it starts the file and shows the install steps.
    const own = mac ? 'mac' : windows ? 'windows' : linux ? (arm ? 'arm64' : 'amd64') : '';
    if (own) document.querySelectorAll('.mv-nav-download:not(.mv-secondary), .mv-mobile-menu nav a[href*="/get-started.html"]').forEach(link => { link.dataset.download = own; });
    document.querySelectorAll(installers.map(p => '[data-download="' + p + '"]').join()).forEach(link => {
      link.href = locale + '/thank-you.html?platform=' + link.dataset.download + '&start=1';
      link.setAttribute('data-download-page', '');
    });
  }

  // Same anonymous aggregate event as the existing site; no app telemetry or IDs.
  const productionHost = ['mailvaultapp.com', 'www.mailvaultapp.com'].includes(location.hostname);
  const pageVersion = 'homepage-en-20261002';
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
  document.querySelectorAll('[data-download]:not([data-download-page])').forEach(link => link.addEventListener('click', () => metric('download_click')));
  document.querySelectorAll('[data-acquisition-event]').forEach(link => link.addEventListener('click', () => acquisitionEvent(link.dataset.acquisitionEvent, {
    ...(link.dataset.acquisitionPlacement ? { placement: link.dataset.acquisitionPlacement } : {}),
    ...(link.dataset.acquisitionDestination ? { destination: link.dataset.acquisitionDestination } : {}),
  })));
  document.querySelectorAll('[data-acquisition-download]:not([data-download-page])').forEach(link => link.addEventListener('click', () => acquisitionEvent('download_action', {
    platform: link.dataset.acquisitionDownload,
    destination: link.dataset.acquisitionResult || (link.dataset.acquisitionDownload === 'snap' ? 'store' : 'fallback'),
  })));
  // Every other CTA: named by where it goes, not by its (localized) label.
  const cta = 'a.mv-button, button.mv-button, .mv-text-link, .mv-navlinks a, .mv-mobile-menu nav a, .mv-footer nav a, .mv-community-actions > *, .mv-social';
  document.addEventListener('click', e => {
    const el = e.target.closest?.(cta);
    if (!el || el.matches('[data-acquisition-event], [data-acquisition-download]') || el.closest('[data-send-link]')) return;
    const href = el.getAttribute('href');
    const url = href && new URL(href, location.href);
    const target = !url ? '#' + (el.id || (el.matches('[data-vote]') ? 'heart' : 'button'))
      : url.origin === location.origin ? url.pathname.replace(/^\/(de|fr|es|it|ja|ko|zh|pt-br)\//, '/') + url.hash
      : url.hostname + url.pathname;
    const placement = el.closest('header') ? 'header' : el.closest('footer') ? 'footer' : el.closest('section[id]')?.id || 'page';
    acquisitionEvent('cta_click', { target, placement });
  });

  const downloadStatus = document.querySelector('[data-download-status]');
  // A [data-download-page] button leads to a page that starts the download itself.
  const direct = platform => '[data-download="' + platform + '"]:not([data-download-page])';
  const downloadControls = document.querySelectorAll(installers.map(direct).join());
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
        const wanted = Object.keys(matches).filter(platform => document.querySelector(direct(platform)));
        let resolved = 0;
        Object.entries(matches).forEach(([platform, asset]) => {
          if (!asset || !wanted.includes(platform)) return;
          const url = new URL(asset.browser_download_url);
          if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/GraphicMeat/mail-vault-app/releases/download/')) return;
          document.querySelectorAll(direct(platform)).forEach(link => { link.href = url.href; link.dataset.acquisitionResult = 'file'; });
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
      if (link.dataset.acquisitionResult === 'file' || link.target === '_blank') return;
      e.preventDefault();
      Promise.race([releaseLinks, new Promise(resolve => setTimeout(resolve, 4000))]).then(() => location.assign(link.href));
    }));
    // The thank-you and Windows pages start the installer when reached from a download button.
    if (autoDownload && query.has('start')) {
      query.delete('start');
      try { history.replaceState(null, '', location.pathname + (String(query) ? '?' + query : '') + location.hash); } catch { /* a reload may download again */ }
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
  // Email me the download link (phones and tablets). The forms also post
  // without a script; the API then redirects back with ?send_link=<outcome>.
  const sendLinkCopy = {
    invalid: () => runtimeText('sendLinkInvalid', 'Check the email address and try again.'),
    limited: () => runtimeText('sendLinkLimited', 'Too many tries. Please try again later.'),
    failed: () => runtimeText('sendLinkFailed', 'We could not send it right now. Please try again in a moment.'),
  };
  function openSendLink(form) {
    const opener = document.querySelector('[data-send-link-open][aria-controls="' + form.id + '"]');
    if (opener) { opener.hidden = true; opener.setAttribute('aria-expanded', 'true'); }
    form.hidden = false;
  }
  function sendLinkDone(form) {
    openSendLink(form);
    form.hidden = true;
    const done = document.querySelector('[data-send-link-done="' + form.dataset.sendLink + '"]');
    if (done) { done.hidden = false; done.focus(); }
  }
  document.querySelectorAll('[data-send-link-open]').forEach(button => button.addEventListener('click', () => {
    const form = document.getElementById(button.getAttribute('aria-controls'));
    if (!form) return;
    openSendLink(form);
    form.elements.email.focus();
  }));
  document.querySelectorAll('[data-send-link]').forEach(form => {
    const status = form.querySelector('[data-send-link-status]');
    const placement = form.dataset.sendLink;
    // The localized pages are copies of the English one, so the language comes from the path.
    form.elements.lang.value = locale.slice(1) || 'en';
    const returned = query.get('send_link');
    const returnedHere = (location.hash === '#download' ? 'final' : 'hero') === placement;
    if (mobile && returned && returnedHere) {
      if (returned === 'sent') sendLinkDone(form);
      else if (sendLinkCopy[returned]) { openSendLink(form); status.textContent = sendLinkCopy[returned](); }
    }
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const button = form.querySelector('[type="submit"]');
      if (button.disabled) return;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = runtimeText('sendLinkSending', 'Sending…');
      button.setAttribute('aria-busy', 'true');
      status.textContent = '';
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email: form.elements.email.value, lang: form.elements.lang.value, website: form.elements.website.value, placement }),
          signal: AbortSignal.timeout(15000),
        });
        if (response.ok) {
          sendLinkDone(form);
          acquisitionEvent('send_link', { placement });
          return;
        }
        status.textContent = (response.status === 400 ? sendLinkCopy.invalid : response.status === 429 ? sendLinkCopy.limited : sendLinkCopy.failed)();
      } catch {
        status.textContent = runtimeText('newsletterReachError', 'We could not reach the server. Check your connection and try again.');
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
