/* Native links and details keep documentation usable without scripting. */
(() => {
  const topics = document.querySelector('.mv-help-sidebar');
  const wide = matchMedia('(min-width:761px)');
  const syncTopics = () => { if (topics) topics.open = wide.matches; };
  syncTopics();
  wide.addEventListener('change', syncTopics);

  const field = document.querySelector('[data-mv-search]');
  if (field) {
    field.value = new URLSearchParams(location.search).get('q') || '';
    document.querySelector('[data-help-clear]')?.addEventListener('click', () => {
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles:true }));
      field.focus();
      history.replaceState(null, '', location.pathname + location.hash);
    });
    if (field.value) field.dispatchEvent(new Event('input', { bubbles:true }));
  }

  const dialog = document.querySelector('.mv-help-lightbox');
  if (!dialog || !dialog.showModal) return;
  let trigger;
  document.querySelectorAll('[data-help-image]').forEach(link => link.addEventListener('click', event => {
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
  }));
  dialog.querySelector('button').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => { document.body.style.overflow = ''; trigger?.focus(); });
})();
