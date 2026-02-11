// Web Worker for background email caching
// Fetches full email content for UIDs and sends them back to main thread

let isPaused = false;
let isStopped = false;
let uidQueue = [];
let apiBaseUrl = '';

// Throttle delay between fetches (ms)
const FETCH_DELAY = 500;

// Helper to sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch a single email from the API
async function fetchEmail(uid, accountId, mailbox, authToken) {
  const response = await fetch(`${apiBaseUrl}/api/email/${uid}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken && { 'Authorization': `Bearer ${authToken}` })
    },
    body: JSON.stringify({ accountId, mailbox })
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch email ${uid}: ${response.statusText}`);
  }

  return response.json();
}

// Process the queue
async function processQueue(accountId, mailbox, authToken) {
  while (uidQueue.length > 0 && !isStopped) {
    // Check if paused
    while (isPaused && !isStopped) {
      await sleep(1000);
    }

    if (isStopped) break;

    const uid = uidQueue.shift();

    try {
      const email = await fetchEmail(uid, accountId, mailbox, authToken);

      // Send the fetched email back to main thread
      self.postMessage({
        type: 'emailFetched',
        uid,
        email
      });

      // Report progress
      self.postMessage({
        type: 'progress',
        completed: 1,
        remaining: uidQueue.length
      });

      // Throttle to avoid overwhelming the server
      await sleep(FETCH_DELAY);
    } catch (error) {
      console.error(`[Worker] Failed to fetch email ${uid}:`, error);
      self.postMessage({
        type: 'error',
        uid,
        error: error.message
      });
    }
  }

  // Done processing
  self.postMessage({
    type: 'done',
    fetchedCount: 0 // Main thread tracks this
  });
}

// Handle messages from main thread
self.onmessage = function(event) {
  const { type, payload } = event.data;

  switch (type) {
    case 'start':
      // Start caching with provided UIDs
      isStopped = false;
      isPaused = false;
      uidQueue = [...payload.uids];
      apiBaseUrl = payload.apiBaseUrl || '';
      processQueue(payload.accountId, payload.mailbox, payload.authToken);
      break;

    case 'pause':
      isPaused = true;
      self.postMessage({ type: 'paused' });
      break;

    case 'resume':
      isPaused = false;
      self.postMessage({ type: 'resumed' });
      break;

    case 'stop':
      isStopped = true;
      uidQueue = [];
      self.postMessage({ type: 'stopped' });
      break;

    default:
      console.warn('[Worker] Unknown message type:', type);
  }
};
