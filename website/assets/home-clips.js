// English homepage: the clip carousels. Each group is a row of large clip cards
// that scrolls sideways with native scroll-snap, so without this script the row
// still scrolls (swipe, trackpad, Tab to a card) and every card is reachable.
// This file adds two things:
//  - The previous and next arrows beside each heading: shown only here, one
//    card per press, disabled at either end, no smooth scroll with reduced
//    motion. Nothing ever advances on its own.
//  - The lazy poster: each card shows an <img loading="lazy"> poster, and its
//    video (preload="none", no poster of its own) sits over it, transparent,
//    until it has played its first frame.
// Playing and pausing stay with english-site.js. Its IntersectionObserver
// watches the viewport, and the browser clips a card's visible area by the
// carousel's scroll box, so a card scrolled sideways out of view pauses and the
// card scrolled in plays, both only while the section is on screen.
// Loaded before english-site.js.
(() => {
  let reduce = false;
  try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* treat as no preference */ }

  document.querySelectorAll('.hm-carousel-track .mv-clip video').forEach(video => {
    const card = video.closest('.mv-clip');
    video.addEventListener('playing', () => card.classList.add('is-live'), { once: true });
  });

  document.querySelectorAll('.hm-carousel-nav').forEach(nav => {
    const prev = nav.querySelector('[data-carousel-prev]');
    const next = nav.querySelector('[data-carousel-next]');
    const track = prev && document.getElementById(prev.getAttribute('aria-controls'));
    if (!track || !next) return;
    // One card and the gap after it; a share of the row if layout is unknown.
    const step = () => {
      const card = track.querySelector('.mv-clip');
      let gap = 0;
      try { gap = parseFloat(getComputedStyle(track).columnGap) || 0; } catch { /* no gap */ }
      const width = card ? card.getBoundingClientRect().width + gap : 0;
      return width > 0 ? width : track.clientWidth * 0.8;
    };
    const update = () => {
      const max = track.scrollWidth - track.clientWidth;
      nav.hidden = max <= 1;
      const ends = [[prev, track.scrollLeft <= 1, next], [next, track.scrollLeft >= max - 1, prev]];
      // Enable first, so a button that turns disabled under the keyboard can
      // hand focus to the other one.
      for (const [button, atEnd] of ends) if (!atEnd) button.disabled = false;
      for (const [button, atEnd, other] of ends) {
        if (!atEnd || button.disabled) continue;
        if (document.activeElement === button && !other.disabled) other.focus();
        button.disabled = true;
      }
    };
    const go = dir => track.scrollBy({ left: dir * step(), behavior: reduce ? 'auto' : 'smooth' });
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    track.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
  });
})();
