// English homepage: the hero clip starts once the page has loaded, without
// waiting for a scroll. english-site.js plays every clip, this one included,
// after the visitor's first scroll: it pauses the hero once it leaves the
// screen and reports its first play as clip_play. This file only adds the early
// start, on screens wider than 760 px. On phones the hero sits under the price
// card, so it keeps the scroll rule. Nothing starts with reduced motion. With
// Save-Data on, the hero becomes its still poster, so neither script can fetch
// the 1.5 MB clip. Loaded before english-site.js, so the swap lands first.
(() => {
  const video = document.querySelector('.hm-hero-clip video');
  if (!video) return;
  const matches = query => { try { return matchMedia(query).matches; } catch { return false; } };
  let saveData = false;
  try { saveData = Boolean(navigator.connection && navigator.connection.saveData); } catch { /* no Network Information API */ }
  if (saveData) {
    const still = document.createElement('img');
    still.className = 'hm-hero-still';
    still.src = video.getAttribute('poster');
    still.width = Number(video.getAttribute('width'));
    still.height = Number(video.getAttribute('height'));
    still.alt = video.getAttribute('aria-label') || '';
    video.replaceWith(still);
    return;
  }
  if (matches('(prefers-reduced-motion: reduce)') || matches('(max-width: 760px)')) return;
  // Only at the top of the page: once the visitor scrolls, english-site.js plays
  // the clip while it is on screen and pauses it when it is not.
  const play = () => {
    if (document.hidden || window.scrollY > 0) return;
    try { Promise.resolve(video.play()).catch(() => {}); } catch { /* the poster stays */ }
  };
  const start = () => {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { play(); return; }
      try { video.pause(); } catch { /* already stopped */ }
    });
    play();
  };
  const soon = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 1500 });
    else setTimeout(start, 300);
  };
  if (document.readyState === 'complete') soon();
  else window.addEventListener('load', soon, { once: true });
})();
