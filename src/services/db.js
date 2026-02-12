import { openDB } from 'idb';

const DB_NAME = 'mailvault-db';
const DB_VERSION = 2;

// Use global Tauri API (more reliable in production builds)
// In Tauri v2, invoke is at window.__TAURI__.core.invoke
const invoke = window.__TAURI__?.core?.invoke;

// Debug logging
console.log('[db.js] Initializing...');
console.log('[db.js] invoke available:', !!invoke);

// Test invoke on startup (only log result, don't test keychain to avoid clutter)
if (invoke) {
  invoke('get_app_data_dir')
    .then(result => console.log('[db.js] Tauri invoke working. App data dir:', result))
    .catch(error => console.error('[db.js] Tauri invoke failed:', error));
}

let db = null;

// Credentials cache - stores all passwords in memory after first fetch
// This avoids multiple keychain accesses
let credentialsCache = null;
let credentialsCacheLoaded = false;

// Get all credentials from keychain (single access)
async function getAllCredentials() {
  if (credentialsCacheLoaded) {
    return credentialsCache || {};
  }

  if (!invoke) {
    credentialsCacheLoaded = true;
    return {};
  }

  try {
    console.log('[db.js] Fetching all credentials from keychain...');
    credentialsCache = await invoke('get_credentials');
    credentialsCacheLoaded = true;
    console.log('[db.js] Credentials loaded for', Object.keys(credentialsCache).length, 'account(s)');
    return credentialsCache;
  } catch (error) {
    console.log('[db.js] No credentials found or error:', error);
    // Try migration from old per-account format
    credentialsCache = await migrateOldCredentials();
    credentialsCacheLoaded = true;
    return credentialsCache;
  }
}

// Migrate from old per-account password storage to new single JSON
async function migrateOldCredentials() {
  if (!invoke) return {};

  console.log('[db.js] Attempting migration from old credential format...');
  const database = await initDB();
  const accounts = await database.getAll('accounts');
  const credentials = {};

  for (const account of accounts) {
    try {
      const password = await invoke('get_password', { accountId: account.id });
      if (password) {
        credentials[account.id] = password;
        console.log('[db.js] Migrated password for account:', account.id);
      }
    } catch {
      // Password not found for this account
    }
  }

  // Store migrated credentials in new format
  if (Object.keys(credentials).length > 0) {
    try {
      await invoke('store_credentials', { credentials });
      console.log('[db.js] Migration complete. Stored', Object.keys(credentials).length, 'credential(s)');
    } catch (error) {
      console.error('[db.js] Failed to store migrated credentials:', error);
    }
  }

  return credentials;
}

// Store all credentials to keychain (single access)
async function storeAllCredentials(credentials) {
  if (!invoke) return;

  try {
    await invoke('store_credentials', { credentials });
    credentialsCache = credentials;
    console.log('[db.js] Stored credentials for', Object.keys(credentials).length, 'account(s)');
  } catch (error) {
    console.error('[db.js] Failed to store credentials:', error);
    throw error;
  }
}

// Clear credentials cache (call this when account data might have changed externally)
export function clearCredentialsCache() {
  credentialsCache = null;
  credentialsCacheLoaded = false;
}

export async function initDB() {
  if (db) return db;
  
  db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      // Accounts store
      if (!database.objectStoreNames.contains('accounts')) {
        const accountStore = database.createObjectStore('accounts', { keyPath: 'id' });
        accountStore.createIndex('email', 'email', { unique: true });
      }
      
      // Emails store - preserves complete email data
      if (!database.objectStoreNames.contains('emails')) {
        const emailStore = database.createObjectStore('emails', { keyPath: 'localId' });
        emailStore.createIndex('accountId', 'accountId');
        emailStore.createIndex('uid', 'uid');
        emailStore.createIndex('messageId', 'messageId');
        emailStore.createIndex('mailbox', 'mailbox');
        emailStore.createIndex('accountMailbox', ['accountId', 'mailbox']);
        emailStore.createIndex('date', 'date');
      }
      
      // Saved emails index - tracks which emails are saved locally
      if (!database.objectStoreNames.contains('savedIndex')) {
        const savedStore = database.createObjectStore('savedIndex', { keyPath: 'key' });
        savedStore.createIndex('accountId', 'accountId');
      }

      // Email headers cache - stores email list headers for instant startup
      if (!database.objectStoreNames.contains('emailHeaders')) {
        const headersStore = database.createObjectStore('emailHeaders', { keyPath: 'cacheKey' });
        headersStore.createIndex('accountId', 'accountId');
        headersStore.createIndex('mailbox', 'mailbox');
        headersStore.createIndex('accountMailbox', ['accountId', 'mailbox']);
      }
    }
  });
  
  return db;
}

// Account operations
export async function saveAccount(account) {
  console.log('[db.js] saveAccount called', { accountId: account.id, hasPassword: !!account.password });

  const database = await initDB();

  // Store password in system keychain (if Tauri is available)
  if (invoke && account.password) {
    console.log('[db.js] Storing password in keychain...');
    try {
      // Get existing credentials and add/update this account's password
      const credentials = await getAllCredentials();
      credentials[account.id] = account.password;
      await storeAllCredentials(credentials);
      console.log('[db.js] Password stored successfully in keychain');
    } catch (error) {
      console.error('[db.js] Failed to store password in keychain:', error);
      throw error;
    }
    // Store account metadata without password in IndexedDB
    const { password, ...accountWithoutPassword } = account;
    await database.put('accounts', accountWithoutPassword);
    console.log('[db.js] Account metadata saved to IndexedDB (without password)');
  } else {
    // Fallback: store full account in IndexedDB (browser mode)
    console.log('[db.js] Fallback: storing full account in IndexedDB');
    await database.put('accounts', account);
  }

  return account;
}

// Get accounts WITHOUT retrieving passwords from keychain
// Use this for quick loading UI without triggering keychain prompts
export async function getAccountsWithoutPasswords() {
  const database = await initDB();
  return database.getAll('accounts');
}

export async function getAccounts() {
  const database = await initDB();
  const accounts = await database.getAll('accounts');

  // Retrieve all passwords from keychain in a single call
  if (invoke) {
    const credentials = await getAllCredentials();
    return accounts.map(account => ({
      ...account,
      password: credentials[account.id] || undefined
    }));
  }

  return accounts;
}

export async function getAccount(id) {
  const database = await initDB();
  const account = await database.get('accounts', id);

  if (account && invoke) {
    const credentials = await getAllCredentials();
    return { ...account, password: credentials[id] || undefined };
  }

  return account;
}

export async function deleteAccount(id) {
  const database = await initDB();

  // Remove password from credentials (if Tauri is available)
  if (invoke) {
    try {
      const credentials = await getAllCredentials();
      delete credentials[id];
      await storeAllCredentials(credentials);
      console.log('[db.js] Password removed from credentials for account:', id);
    } catch (error) {
      console.error('[db.js] Failed to remove password from credentials:', error);
      // Continue with account deletion even if password removal fails
    }
  }

  // Delete all saved emails for this account
  const tx = database.transaction(['accounts', 'emails', 'savedIndex'], 'readwrite');
  
  // Delete emails
  const emailIndex = tx.objectStore('emails').index('accountId');
  let cursor = await emailIndex.openCursor(IDBKeyRange.only(id));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  
  // Delete saved index entries
  const savedIndex = tx.objectStore('savedIndex').index('accountId');
  cursor = await savedIndex.openCursor(IDBKeyRange.only(id));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  
  // Delete account
  await tx.objectStore('accounts').delete(id);
  await tx.done;
}

// Email operations
export async function saveEmail(email, accountId, mailbox) {
  const database = await initDB();
  
  // Create unique local ID
  const localId = `${accountId}-${mailbox}-${email.uid}`;
  
  const emailData = {
    localId,
    accountId,
    mailbox,
    savedAt: new Date().toISOString(),
    // Preserve complete email structure
    ...email
  };
  
  const tx = database.transaction(['emails', 'savedIndex'], 'readwrite');
  
  // Save email
  await tx.objectStore('emails').put(emailData);
  
  // Update saved index
  await tx.objectStore('savedIndex').put({
    key: localId,
    accountId,
    mailbox,
    uid: email.uid,
    messageId: email.messageId,
    savedAt: emailData.savedAt
  });
  
  await tx.done;
  return emailData;
}

export async function saveEmails(emails, accountId, mailbox) {
  const database = await initDB();
  const tx = database.transaction(['emails', 'savedIndex'], 'readwrite');
  
  const results = [];
  
  for (const email of emails) {
    const localId = `${accountId}-${mailbox}-${email.uid}`;
    
    const emailData = {
      localId,
      accountId,
      mailbox,
      savedAt: new Date().toISOString(),
      ...email
    };
    
    await tx.objectStore('emails').put(emailData);
    
    await tx.objectStore('savedIndex').put({
      key: localId,
      accountId,
      mailbox,
      uid: email.uid,
      messageId: email.messageId,
      savedAt: emailData.savedAt
    });
    
    results.push(emailData);
  }
  
  await tx.done;
  return results;
}

export async function getLocalEmail(accountId, mailbox, uid) {
  const database = await initDB();
  const localId = `${accountId}-${mailbox}-${uid}`;
  return database.get('emails', localId);
}

export async function getLocalEmails(accountId, mailbox) {
  const database = await initDB();
  const index = database.transaction('emails').store.index('accountMailbox');
  return index.getAll([accountId, mailbox]);
}

export async function getAllLocalEmails(accountId) {
  const database = await initDB();
  const index = database.transaction('emails').store.index('accountId');
  return index.getAll(accountId);
}

export async function deleteLocalEmail(localId) {
  const database = await initDB();
  const tx = database.transaction(['emails', 'savedIndex'], 'readwrite');
  await tx.objectStore('emails').delete(localId);
  await tx.objectStore('savedIndex').delete(localId);
  await tx.done;
}

export async function deleteLocalEmails(localIds) {
  const database = await initDB();
  const tx = database.transaction(['emails', 'savedIndex'], 'readwrite');
  
  for (const localId of localIds) {
    await tx.objectStore('emails').delete(localId);
    await tx.objectStore('savedIndex').delete(localId);
  }
  
  await tx.done;
}

export async function isEmailSaved(accountId, mailbox, uid) {
  const database = await initDB();
  const localId = `${accountId}-${mailbox}-${uid}`;
  const entry = await database.get('savedIndex', localId);
  return !!entry;
}

export async function getSavedEmailIds(accountId, mailbox) {
  const database = await initDB();
  const index = database.transaction('savedIndex').store.index('accountId');
  const entries = await index.getAll(accountId);
  
  const savedIds = new Set();
  for (const entry of entries) {
    if (entry.mailbox === mailbox) {
      savedIds.add(entry.uid);
    }
  }
  
  return savedIds;
}

export async function exportEmail(localId) {
  const database = await initDB();
  const email = await database.get('emails', localId);
  
  if (!email) return null;
  
  // Return the raw source if available (complete .eml format)
  if (email.rawSource) {
    return {
      filename: `${email.subject.replace(/[^a-zA-Z0-9]/g, '_')}.eml`,
      content: atob(email.rawSource),
      mimeType: 'message/rfc822'
    };
  }
  
  // Fallback: export as JSON with all metadata
  return {
    filename: `${email.subject.replace(/[^a-zA-Z0-9]/g, '_')}.json`,
    content: JSON.stringify(email, null, 2),
    mimeType: 'application/json'
  };
}

// Email headers cache operations
// Uses file-based caching via Tauri when available, with IndexedDB as fallback
export async function saveEmailHeaders(accountId, mailbox, emails, totalEmails) {
  const cacheEntry = {
    accountId,
    mailbox,
    emails,
    totalEmails,
    lastSynced: Date.now()
  };

  // Try file-based cache first (Tauri)
  if (invoke) {
    try {
      const data = JSON.stringify(cacheEntry);
      await invoke('save_email_cache', { accountId, mailbox, data });
      console.log('[db.js] Email headers saved to file cache:', emails.length, 'emails');
    } catch (error) {
      console.warn('[db.js] Failed to save to file cache, falling back to IndexedDB:', error);
    }
  }

  // Also save to IndexedDB as backup
  try {
    const database = await initDB();
    const cacheKey = `${accountId}-${mailbox}`;
    await database.put('emailHeaders', { cacheKey, ...cacheEntry });
  } catch (error) {
    console.warn('[db.js] Failed to save to IndexedDB:', error);
  }

  return cacheEntry;
}

export async function getEmailHeaders(accountId, mailbox) {
  // Try file-based cache first (Tauri) - more reliable across app restarts
  if (invoke) {
    try {
      const data = await invoke('load_email_cache', { accountId, mailbox });
      if (data) {
        const entry = JSON.parse(data);
        console.log('[db.js] Email headers loaded from file cache:', entry.emails?.length, 'emails');
        return {
          emails: entry.emails,
          totalEmails: entry.totalEmails,
          lastSynced: entry.lastSynced
        };
      }
    } catch (error) {
      console.warn('[db.js] Failed to load from file cache, trying IndexedDB:', error);
    }
  }

  // Fallback to IndexedDB
  try {
    const database = await initDB();
    const cacheKey = `${accountId}-${mailbox}`;
    const entry = await database.get('emailHeaders', cacheKey);

    if (entry) {
      console.log('[db.js] Email headers loaded from IndexedDB:', entry.emails?.length, 'emails');
      return {
        emails: entry.emails,
        totalEmails: entry.totalEmails,
        lastSynced: entry.lastSynced
      };
    }
  } catch (error) {
    console.warn('[db.js] Failed to load from IndexedDB:', error);
  }

  return null;
}

export async function clearEmailHeadersCache(accountId) {
  // Clear file-based cache (Tauri)
  if (invoke) {
    try {
      await invoke('clear_email_cache', { accountId: accountId || null });
      console.log('[db.js] File-based email cache cleared for:', accountId || 'all accounts');
    } catch (error) {
      console.warn('[db.js] Failed to clear file cache:', error);
    }
  }

  // Also clear IndexedDB cache
  try {
    const database = await initDB();
    const tx = database.transaction('emailHeaders', 'readwrite');
    const index = tx.store.index('accountId');
    let cursor = await index.openCursor(IDBKeyRange.only(accountId));

    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }

    await tx.done;
    console.log('[db.js] IndexedDB email headers cache cleared for:', accountId);
  } catch (error) {
    console.warn('[db.js] Failed to clear IndexedDB cache:', error);
  }
}

// Calculate storage usage for saved emails in IndexedDB
export async function getStorageUsage() {
  const database = await initDB();

  // Get all saved emails
  const emails = await database.getAll('emails');
  const headers = await database.getAll('emailHeaders');

  // Calculate sizes
  let emailsSize = 0;
  let headersSize = 0;
  let emailCount = emails.length;

  for (const email of emails) {
    try {
      emailsSize += new Blob([JSON.stringify(email)]).size;
    } catch {
      emailsSize += 1000; // Estimate 1KB if serialization fails
    }
  }

  for (const header of headers) {
    try {
      headersSize += new Blob([JSON.stringify(header)]).size;
    } catch {
      headersSize += 500;
    }
  }

  const totalBytes = emailsSize + headersSize;
  const totalMB = totalBytes / (1024 * 1024);

  return {
    totalMB,
    totalBytes,
    emailCount,
    emailsSizeMB: emailsSize / (1024 * 1024),
    headersSizeMB: headersSize / (1024 * 1024)
  };
}

// Search locally saved emails in IndexedDB
export async function searchLocalEmails(accountId, query, filters = {}) {
  const database = await initDB();
  const index = database.transaction('emails').store.index('accountId');
  const allEmails = await index.getAll(accountId);

  if (!allEmails || allEmails.length === 0) {
    return [];
  }

  const queryLower = query?.toLowerCase().trim() || '';

  const results = allEmails.filter(email => {
    // Text search in sender, subject, and body
    const senderMatch = !queryLower ||
      email.from?.address?.toLowerCase().includes(queryLower) ||
      email.from?.name?.toLowerCase().includes(queryLower);

    const subjectMatch = !queryLower ||
      email.subject?.toLowerCase().includes(queryLower);

    const bodyMatch = !queryLower ||
      email.text?.toLowerCase().includes(queryLower) ||
      email.html?.toLowerCase().includes(queryLower);

    // Sender filter
    const senderFilterMatch = !filters.sender ||
      email.from?.address?.toLowerCase().includes(filters.sender.toLowerCase()) ||
      email.from?.name?.toLowerCase().includes(filters.sender.toLowerCase());

    // Date filters
    const emailDate = new Date(email.date || email.internalDate);
    const dateFromMatch = !filters.dateFrom ||
      emailDate >= new Date(filters.dateFrom);
    const dateToMatch = !filters.dateTo ||
      emailDate <= new Date(filters.dateTo);

    // Mailbox filter
    const mailboxMatch = !filters.mailbox ||
      filters.mailbox === 'all' ||
      email.mailbox === filters.mailbox;

    // Attachments filter
    const attachmentMatch = !filters.hasAttachments ||
      (email.attachments && email.attachments.length > 0) ||
      email.hasAttachments;

    // Must match query in at least one field AND all filters
    const queryMatch = !queryLower || senderMatch || subjectMatch || bodyMatch;

    return queryMatch && senderFilterMatch && dateFromMatch && dateToMatch && mailboxMatch && attachmentMatch;
  });

  // Mark as local source
  return results.map(e => ({
    ...e,
    isLocal: true,
    source: 'local'
  }));
}
