// In Tauri production build, we need the full URL since webview origin isn't localhost
const API_BASE = window.__TAURI__ ? 'http://localhost:3001/api' : '/api';

console.log('[api.js] API_BASE:', API_BASE);
console.log('[api.js] Running in Tauri:', !!window.__TAURI__);

// Default timeout for fetch requests (30 seconds)
const DEFAULT_FETCH_TIMEOUT = 30000;

// Server readiness state — ensures sidecar is up before first API call
let serverReady = !window.__TAURI__; // Skip wait in browser dev mode
let serverReadyPromise = null;

async function waitForServer() {
  if (serverReady) return;
  if (serverReadyPromise) return serverReadyPromise;

  serverReadyPromise = (async () => {
    const maxAttempts = 30;
    const delay = 500; // ms
    console.log('[api.js] Waiting for backend server to be ready...');

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`${API_BASE}/health`);
        if (res.ok) {
          console.log(`[api.js] Server ready after ${i + 1} attempt(s)`);
          serverReady = true;
          return;
        }
      } catch {
        // Server not up yet
      }
      await new Promise(r => setTimeout(r, delay));
    }

    // Reset so next API call retries the health check
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
  await waitForServer();

  const url = `${API_BASE}${endpoint}`;
  console.log('[api.js] Making request to:', url);

  // Set up AbortController with timeout
  const timeout = options.timeout || DEFAULT_FETCH_TIMEOUT;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    const { timeout: _timeout, ...fetchOptions } = options;
    response = await fetch(url, {
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
      console.error('[api.js] Request timed out for', endpoint);
      throw new ApiError(
        `Request timed out (${endpoint}). The server took too long to respond.`,
        0
      );
    }
    console.error('[api.js] Fetch failed for', endpoint, ':', error);
    throw new ApiError(
      `Server unreachable (${endpoint}): ${error.message}. The backend server may not be running.`,
      0
    );
  }
  clearTimeout(timeoutId);

  console.log('[api.js] Response status:', response.status);

  let data;
  try {
    data = await response.json();
  } catch (error) {
    console.error('[api.js] Failed to parse response for', endpoint, ':', error);
    throw new ApiError(
      `Invalid response from server (${endpoint}): HTTP ${response.status}`,
      response.status
    );
  }

  if (!response.ok || !data.success) {
    console.error('[api.js] Request failed:', data.error);
    throw new ApiError(
      data.error || `Request failed (${endpoint}): HTTP ${response.status}`,
      response.status
    );
  }

  return data;
}

export async function testConnection(account) {
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
