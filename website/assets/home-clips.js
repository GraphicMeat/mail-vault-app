// English homepage: the lazy clip posters. Each card in a clip group shows an
// <img loading="lazy"> poster, and its video (preload="none", no poster of its
// own) sits over it, transparent, until it has played its first frame. This
// marks the card live then, so the clip fades in over its poster.
// Playing and pausing stay with english-site.js (on screen, after the first
// scroll, never with reduced motion). Loaded before english-site.js.
(() => {
  document.querySelectorAll('.hm-clip-group .mv-clip video').forEach(video => {
    const card = video.closest('.mv-clip');
    video.addEventListener('playing', () => card.classList.add('is-live'), { once: true });
  });
})();
