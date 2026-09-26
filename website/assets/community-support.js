/* Restore the existing homepage votes and public GitHub star count. */
(function () {
  const button = document.getElementById('want-this-btn');
  if (!button) return;
  const status = document.getElementById('vote-status');
  const label = document.getElementById('vote-label');
  let runtimeCopy = {};
  try { runtimeCopy = JSON.parse(document.querySelector('#mv-runtime-copy')?.textContent || '{}'); } catch (_) {}
  const runtimeText = (key, fallback) => runtimeCopy[key] || fallback;
  let voted = false;
  try { voted = localStorage.getItem('mailvault-voted') === 'true'; } catch (_) {}
  function reflectVote() {
    button.setAttribute('aria-pressed', String(voted));
    if (voted) label.textContent = runtimeText('voteThanks', 'Thanks for the love!');
  }
  function count(id, value) {
    if (!Number.isInteger(value) || value < 0) return;
    // The header's star and heart counters share the ids as data attributes.
    document.querySelectorAll('#' + id + ', [data-' + id + ']').forEach(node => {
      node.textContent = value.toLocaleString();
      node.hidden = false;
    });
  }
  async function json(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error('Request failed');
    return response.json();
  }
  reflectVote();
  json('/api/votes').then(data => count('vote-count', data.count)).catch(() => {});
  json('https://api.github.com/repos/GraphicMeat/mail-vault-app')
    .then(data => count('github-stars', data.stargazers_count)).catch(() => {});
  button.addEventListener('click', async () => {
    try { voted = voted || localStorage.getItem('mailvault-voted') === 'true'; } catch (_) {}
    if (voted) { status.textContent = runtimeText('voteAlreadyCounted', 'Your heart has already been counted. Thank you!'); return; }
    button.disabled = true;
    status.textContent = '';
    try {
      const data = await json('/api/votes', { method: 'POST', headers: { Accept: 'application/json' } });
      if (!Number.isInteger(data.count) || data.count < 0) throw new Error('Invalid count');
      count('vote-count', data.count);
      voted = true;
      try { localStorage.setItem('mailvault-voted', 'true'); } catch (_) {}
      reflectVote();
      document.querySelectorAll('[data-vote]').forEach(heart => heart.setAttribute('aria-pressed', 'true'));
      status.textContent = runtimeText('voteSupporting', 'Thank you for supporting MailVault!');
    } catch (_) { status.textContent = runtimeText('voteSendError', 'Couldn’t send your heart. Please try again shortly.'); }
    finally { button.disabled = false; }
  });
})();
