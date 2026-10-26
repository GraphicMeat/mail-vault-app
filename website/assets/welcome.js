// Welcome page after a web checkout. Stripe returns here with ?session_id=...;
// the button trades it for a one-time token and opens mailvault://activate. The
// token is minted on the click, not on load, so its 15 minutes start when the
// app is installed and ready. Nothing here is sent to analytics: the session id
// and the token are credentials.
(() => {
  const root = document.querySelector('[data-welcome]');
  if (!root) return;
  const sessionId = new URLSearchParams(location.search).get('session_id') || '';
  const web = /^cs_(?:test|live)_[A-Za-z0-9]+$/.test(sessionId);
  const activate = root.querySelector('[data-welcome-activate]');
  root.querySelectorAll('[data-welcome-web]').forEach(el => { el.hidden = !web; });
  root.querySelectorAll('[data-welcome-app]').forEach(el => { el.hidden = web; });
  if (!web) { activate.hidden = true; return; }
  activate.hidden = false;

  const button = activate.querySelector('[data-welcome-open]');
  const message = name => {
    activate.querySelectorAll('[data-welcome-msg]').forEach(el => { el.hidden = el.dataset.welcomeMsg !== name; });
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    message('');
    try {
      const res = await fetch('/api/billing/activation-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (res.status === 404 || res.status === 409 || res.status === 410) { message('expired'); return; }
      if (!res.ok) { message('failed'); return; }
      const { deepLink } = await res.json();
      // A link click, not location.href: the page stays put whether or not an app answers.
      const link = document.createElement('a');
      link.href = deepLink;
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
      message('opened');
    } catch {
      message('failed');
    } finally {
      button.disabled = false;
    }
  });
})();
