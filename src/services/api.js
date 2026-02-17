// In Tauri production build, we need the full URL since webview origin isn't localhost
const API_BASE = window.__TAURI__ ? 'http://localhost:3001/api' : '/api';

console.log('[api.js] API_BASE:', API_BASE);
console.log('[api.js] Running in Tauri:', !!window.__TAURI__);

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  console.log('[api.js] Making request to:', url);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });
  } catch (error) {
    console.error('[api.js] Fetch failed for', endpoint, ':', error);
    throw new ApiError(
      `Server unreachable (${endpoint}): ${error.message}. The backend server may not be running.`,
      0
    );
  }

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
    body: JSON.stringify({ account })
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
