/* Reddit ad measurement, consent first. english-site.js fetches this file only for a visit
   that began on a Reddit ad (or on the privacy page, for the withdraw button), so every other
   visitor downloads nothing from here and never talks to Reddit. */
(() => {
  'use strict';
  const PIXEL_ID = 'a2_jyqdj6oz5zbw';
  const CHOICE = 'mv-reddit-consent';
  const store = (op, key, value) => {
    try { return op === 'get' ? localStorage.getItem(key) : op === 'set' ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { return null; }
  };
  const fromAd = (() => { try { return sessionStorage.getItem('mv-reddit-ad') === '1'; } catch { return false; } })();

  // Reddit's own snippet, unmodified apart from the id living in one constant.
  function loadPixel() {
    if (window.rdt) return;
    !function(w,d){if(!w.rdt){var p=w.rdt=function(){p.sendEvent?p.sendEvent.apply(p,arguments):p.callQueue.push(arguments)};p.callQueue=[];var t=d.createElement("script");t.src="https://www.redditstatic.com/ads/pixel.js?pixel_id="+PIXEL_ID,t.async=!0;var s=d.getElementsByTagName("script")[0];s.parentNode.insertBefore(t,s)}}(window,document);
    window.rdt('init', PIXEL_ID);
    window.rdt('track', 'PageVisit');
    // The thank-you page is where every installer download lands. One id per tab, so a reload
    // of that page repeats the same conversion and Reddit can drop the duplicate.
    if (/(^|\/)thank-you\.html$/.test(location.pathname)) {
      let id = null;
      try { id = sessionStorage.getItem('mv-reddit-conv'); } catch { /* new id below */ }
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
        try { sessionStorage.setItem('mv-reddit-conv', id); } catch { /* the id is still sent once */ }
      }
      window.rdt('track', 'Lead', { conversionId: id });
    }
  }

  // Consent is asked only where the law requires it: the EEA, the UK and Switzerland (and their
  // Crown dependencies). Elsewhere an ad visit loads the pixel straight away. Cloudflare answers
  // "where is this visitor" at /cdn-cgi/trace; if that fails, the visitor is asked.
  const CONSENT_REGIONS = new Set(['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','GB','CH','GG','JE','IM']);
  function consentNeeded() {
    return fetch('/cdn-cgi/trace', { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => {
        const loc = (text.match(/^loc=([A-Z]{2})$/m) || [])[1];
        return !loc || loc === 'XX' || loc === 'T1' || CONSENT_REGIONS.has(loc);
      })
      .catch(() => true);
  }

  // Withdrawing is as easy as accepting: remember "no" and drop the cookies the pixel wrote here.
  function clearPixelCookies() {
    const host = location.hostname.split('.');
    const domains = ['', ...host.map((_, i) => '; domain=.' + host.slice(i).join('.'))];
    document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(n => n.startsWith('_rdt_')).forEach(name => {
      domains.forEach(d => { document.cookie = name + '=; Max-Age=0; path=/' + d; });
    });
  }
  function withdraw() {
    store('set', CHOICE, 'denied');
    clearPixelCookies();
  }
  document.querySelectorAll('[data-ad-consent-reset]').forEach(button => {
    const status = document.querySelector('[data-ad-consent-status]');
    button.addEventListener('click', () => {
      withdraw();
      if (status) status.textContent = 'Done. Reddit measurement is off for this browser.';
    });
  });

  if (!fromAd) return;
  // A browser that says "do not sell or share" is answered without asking.
  if (navigator.globalPrivacyControl === true) { withdraw(); return; }
  const saved = store('get', CHOICE);
  if (saved === 'granted') { loadPixel(); return; }
  if (saved === 'denied') return;

  consentNeeded().then(needed => { if (needed) askForConsent(); else loadPixel(); });

  function askForConsent() {
    const style = document.createElement('style');
    style.textContent = '.mv-adconsent{position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483000;max-width:34rem;margin:0 auto;padding:16px 18px;border-radius:14px;background:#fff;color:#0f172a;border:1px solid #cbd5e1;box-shadow:0 12px 40px rgba(15,23,42,.22);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}' +
      'html.dark .mv-adconsent{background:#111827;color:#f1f5f9;border-color:#334155}' +
      '.mv-adconsent p{margin:0 0 12px}.mv-adconsent a{color:inherit;text-decoration:underline}' +
      '.mv-adconsent div{display:flex;gap:10px;flex-wrap:wrap}' +
      '.mv-adconsent button{flex:1 1 8rem;min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid #6366f1;font:inherit;font-weight:600;cursor:pointer;background:#6366f1;color:#fff}' +
      '.mv-adconsent button[data-choice="denied"]{background:transparent;color:inherit;border-color:#94a3b8}';
    const bar = document.createElement('section');
    bar.className = 'mv-adconsent';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Advertising consent');
    bar.innerHTML = '<p>You came from a Reddit ad. May we share this visit with Reddit (the pages you view, your IP address and a cookie) so we can measure the ad? Nothing else on this site tracks you. <a href="/privacy.html#advertising">Details</a></p>' +
      '<div><button type="button" data-choice="denied">No thanks</button><button type="button" data-choice="granted">Accept</button></div>';
    bar.addEventListener('click', event => {
      const choice = event.target.closest('button[data-choice]')?.dataset.choice;
      if (!choice) return;
      store('set', CHOICE, choice);
      bar.remove();
      style.remove();
      if (choice === 'granted') loadPixel();
    });
    document.head.append(style);
    document.body.append(bar);
  }
})();
