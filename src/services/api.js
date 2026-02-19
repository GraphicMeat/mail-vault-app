// In Tauri production build, we need the full URL since webview origin isn't localhost
const API_BASE = window.__TAURI__ ? 'http://localhost:3001/api' : '/api';

console.log('[api.js] API_BASE:', API_BASE);
console.log('[api.js] Running in Tauri:', !!window.__TAURI__);
console.log('[api.js] Window origin:', window.location?.origin);
console.log('[api.js] User agent:', navigator.userAgent);

// Default timeout for fetch requests (30 seconds)
const DEFAULT_FETCH_TIMEOUT = 30000;

// Use Tauri's HTTP plugin fetch in production builds — WKWebView's native fetch
// is blocked by App Sandbox when making requests from tauri:// to http://localhost.
// The plugin routes requests through Rust's networking stack, bypassing WebView restrictions.
let tauriFetch = null;
let fetchMode = 'native'; // 'native' or 'tauri-plugin'

const tauriFetchReady = window.__TAURI__
  ? import('@tauri-apps/plugin-http').then(mod => {
      tauriFetch = mod.fetch;
      fetchMode = 'tauri-plugin';
      console.log('[api.js] Tauri HTTP plugin loaded successfully');
    }).catch(err => {
      console.error('[api.js] Tauri HTTP plugin FAILED to load:', err);
      console.error('[api.js] Will fall back to native fetch (may fail in sandbox)');
    })
  : Promise.resolve();

function getFetch() {
  return tauriFetch || fetch;
}

// Server readiness state — ensures sidecar is up before first API call
let serverReady = !window.__TAURI__; // Skip wait in browser dev mode
let serverReadyPromise = null;

async function waitForServer() {
  if (serverReady) return;

  // Ensure Tauri HTTP plugin is loaded before polling
  console.log('[api.js] waitForServer: waiting for Tauri HTTP plugin...');
  await tauriFetchReady;
  console.log('[api.js] waitForServer: using fetch mode:', fetchMode);

  if (serverReadyPromise) {
    console.log('[api.js] waitForServer: reusing existing health check promise');
    return serverReadyPromise;
  }

  serverReadyPromise = (async () => {
    const maxAttempts = 30;
    const delay = 500; // ms
    const doFetch = getFetch();
    console.log('[api.js] Starting health check polling (%d attempts, %dms delay)...', maxAttempts, delay);

    for (let i = 0; i < maxAttempts; i++) {
      try {
        console.log('[api.js] Health check attempt %d/%d...', i + 1, maxAttempts);
        const res = await doFetch(`${API_BASE}/health`);
        console.log('[api.js] Health check response: status=%d, ok=%s', res.status, res.ok);
        if (res.ok) {
          const data = await res.json().catch(() => null);
          console.log('[api.js] Server ready after %d attempt(s), data:', i + 1, data);
          serverReady = true;
          return;
        }
      } catch (err) {
        console.log('[api.js] Health check attempt %d failed: %s', i + 1, err.message || err);
      }
      await new Promise(r => setTimeout(r, delay));
    }

    // Reset so next API call retries the health check
    console.error('[api.js] Server did not become ready after %d attempts (%ds)', maxAttempts, (maxAttempts * delay) / 1000);
    serverReadyPromise = null;
    throw new ApiError(
      'Backend server did not start. Please restart the app.',
      0
    );
  })();

  return serverReadyPromise;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request(endpoint, options = {}) {
  // Wait for sidecar server to be ready on first API call
  console.log('[api.js] request: %s %s', options.method || 'GET', endpoint);
  await waitForServer();

  const url = `${API_BASE}${endpoint}`;

  // Set up AbortController with timeout
  const timeout = options.timeout || DEFAULT_FETCH_TIMEOUT;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const doFetch = getFetch();
  console.log('[api.js] Fetching %s (timeout: %dms, mode: %s)', url, timeout, fetchMode);

  let response;
  try {
    const { timeout: _timeout, ...fetchOptions } = options;
    response = await doFetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...fetchOptions.headers
      },
      ...fetchOptions,
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error('[api.js] Request TIMED OUT after %dms for %s', timeout, endpoint);
      throw new ApiError(
        `Request timed out (${endpoint}). The server took too long to respond.`,
        0
      );
    }
    console.error('[api.js] Fetch FAILED for %s: [%s] %s', endpoint, error.name, error.message);
    throw new ApiError(
      `Server unreachable (${endpoint}): ${error.message}. The backend server may not be running.`,
      0
    );
  }
  clearTimeout(timeoutId);

  console.log('[api.js] Response: %s %d', endpoint, response.status);

  let data;
  try {
    data = await response.json();
  } catch (error) {
    console.error('[api.js] Failed to parse JSON for %s: %s', endpoint, error.message);
    throw new ApiError(
      `Invalid response from server (${endpoint}): HTTP ${response.status}`,
      response.status
    );
  }

  if (!response.ok || !data.success) {
    console.error('[api.js] Request failed: %s — %s', endpoint, data.error);
    throw new ApiError(
      data.error || `Request failed (${endpoint}): HTTP ${response.status}`,
      response.status
    );
  }

  return data;
}

export async function testConnection(account) {
  console.log('[api.js] testConnection: %s @ %s:%d', account.email, account.imapHost, account.imapPort);
  return request('/test-connection', {
    method: 'POST',
    body: JSON.stringify({ account }),
    timeout: 20000 // 20s — server IMAP timeout is 15s, leave margin
  });
}

export async function fetchMailboxes(account) {
  const data = await request('/mailboxes', {
    method: 'POST',
    body: JSON.stringify({ account })
  });
  return data.mailboxes;
}

export async function fetchEmails(account, mailbox = 'INBOX', page = 1, limit = 50) {
  const data = await request('/emails', {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, page, limit })
  });
  return data;
}

export async function fetchEmailsRange(account, mailbox = 'INBOX', startIndex = 0, endIndex = 50) {
  const data = await request('/emails-range', {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, startIndex, endIndex })
  });
  return data;
}

export async function fetchEmail(account, uid, mailbox = 'INBOX') {
  const data = await request(`/email/${uid}`, {
    method: 'POST',
    body: JSON.stringify({ account, mailbox })
  });
  return data.email;
}

export async function updateEmailFlags(account, uid, flags, action = 'add', mailbox = 'INBOX') {
  return request(`/email/${uid}/flags`, {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, flags, action })
  });
}

export async function deleteEmail(account, uid, mailbox = 'INBOX', permanent = false) {
  return request(`/email/${uid}/delete`, {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, permanent })
  });
}

export async function sendEmail(account, email) {
  return request('/send', {
    method: 'POST',
    body: JSON.stringify({ account, email })
  });
}

export async function disconnect(account) {
  return request('/disconnect', {
    method: 'POST',
    body: JSON.stringify({ account })
  });
}

export async function searchEmails(account, mailbox = 'INBOX', query, filters = {}) {
  const data = await request('/search', {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, query, filters })
  });
  return data;
}

// --- OAuth2 API functions ---

export async function getOAuth2AuthUrl(email) {
  const params = email ? `?login_hint=${encodeURIComponent(email)}` : '';
  const data = await request(`/oauth2/auth-url${params}`, { method: 'GET' });
  return data;
}

export async function exchangeOAuth2Code(state) {
  const data = await request('/oauth2/exchange', {
    method: 'POST',
    body: JSON.stringify({ state })
  });
  return data;
}

export async function refreshOAuth2Token(refreshToken) {
  const data = await request('/oauth2/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken })
  });
  return data;
}
