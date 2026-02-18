import express from 'express';
import cors from 'cors';
import http from 'http';
import crypto from 'crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import { MICROSOFT_OAUTH, getMicrosoftCredentials } from './oauth2Config.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Extract detailed error info from IMAP/network errors
function getErrorDetail(error) {
  const parts = [error.message];
  if (error.responseText) parts.push(`Server: ${error.responseText}`);
  if (error.response) parts.push(`Response: ${error.response}`);
  if (error.serverResponseCode) parts.push(`Code: ${error.serverResponseCode}`);
  if (error.code && error.code !== error.message) parts.push(`(${error.code})`);
  return parts.filter(Boolean).join(' | ');
}

// Store active connections - background operations
const connections = new Map();
// Store priority connections - user-initiated operations (viewing emails, attachments)
const priorityConnections = new Map();

// Connection config
const CONNECTION_TIMEOUT = 30000; // 30 seconds

// Helper to build IMAP auth config (password or OAuth2)
function buildImapAuth(account) {
  if (account.authType === 'oauth2') {
    return {
      user: account.email,
      accessToken: account.oauth2AccessToken
    };
  }
  return {
    user: account.email,
    pass: account.password
  };
}

// Helper to create a new IMAP connection
async function createConnection(account) {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort || 993,
    secure: account.imapSecure !== false,
    auth: buildImapAuth(account),
    logger: false,
    connectTimeout: CONNECTION_TIMEOUT,
    greetingTimeout: CONNECTION_TIMEOUT,
    socketTimeout: CONNECTION_TIMEOUT,
    // Force IPv4 to avoid IPv6 connection hangs (especially with Outlook)
    tls: {
      servername: account.imapHost,
    },
    socketOptions: {
      family: 4
    },
    // Limit to 1 connection per account
    maxIdleTime: 30000
  });
  
  // Handle errors without crashing
  client.on('error', (err) => {
    console.error(`IMAP error for ${account.email}:`, err.message);
    const key = `${account.email}-${account.imapHost}`;
    connections.delete(key);
  });
  
  client.on('close', () => {
    console.log(`IMAP connection closed for ${account.email}`);
    const key = `${account.email}-${account.imapHost}`;
    connections.delete(key);
  });
  
  await client.connect();
  return client;
}

// Helper to get or create IMAP connection with error recovery
async function getConnection(account, usePriority = false) {
  const key = `${account.email}-${account.imapHost}`;
  const connectionPool = usePriority ? priorityConnections : connections;

  // Check existing connection
  if (connectionPool.has(key)) {
    const conn = connectionPool.get(key);
    if (conn.usable) {
      return conn;
    }
    // Connection is stale, remove it
    connectionPool.delete(key);
    try {
      await conn.logout();
    } catch (e) {
      // Ignore logout errors
    }
  }

  // Create new connection
  const client = await createConnection(account);
  connectionPool.set(key, client);
  return client;
}

// Get priority connection for user-initiated operations
// This ensures viewing emails/attachments isn't blocked by background loading
async function getPriorityConnection(account) {
  return getConnection(account, true);
}

// Wrapper for IMAP operations with error handling
// usePriority=true uses a separate connection pool for user-initiated operations
async function withConnection(account, operation, usePriority = false) {
  const key = `${account.email}-${account.imapHost}`;
  const connectionPool = usePriority ? priorityConnections : connections;

  try {
    const client = await getConnection(account, usePriority);
    return await operation(client);
  } catch (error) {
    console.error(`[withConnection] IMAP error for ${account.email}:`, {
      message: error.message,
      code: error.code,
      responseText: error.responseText,
      response: error.response,
      serverResponseCode: error.serverResponseCode
    });
    // Remove failed connection
    connectionPool.delete(key);

    // Retry once with fresh connection
    if (error.code === 'ETIMEOUT' || error.code === 'ECONNRESET' || error.message?.includes('Socket')) {
      console.log(`Retrying ${usePriority ? 'priority ' : ''}connection for ${account.email}...`);
      try {
        const client = await createConnection(account);
        connectionPool.set(key, client);
        return await operation(client);
      } catch (retryError) {
        connectionPool.delete(key);
        throw retryError;
      }
    }

    throw error;
  }
}

// Wrapper specifically for user-initiated operations (priority connection)
async function withPriorityConnection(account, operation) {
  return withConnection(account, operation, true);
}

// Get list of mailboxes/folders
app.post('/api/mailboxes', async (req, res) => {
  try {
    const { account } = req.body;
    
    const mailboxes = await withConnection(account, async (client) => {
      const mailboxList = await client.list();
      
      // Build tree structure from flat list
      const mailboxMap = new Map();
      const rootMailboxes = [];
      
      for (const mailbox of mailboxList) {
        const item = {
          name: mailbox.name,
          path: mailbox.path,
          specialUse: mailbox.specialUse,
          flags: mailbox.flags ? Array.from(mailbox.flags) : [],
          delimiter: mailbox.delimiter,
          children: []
        };
        mailboxMap.set(mailbox.path, item);
        
        const delimiterIndex = mailbox.path.lastIndexOf(mailbox.delimiter || '/');
        if (delimiterIndex > 0) {
          const parentPath = mailbox.path.substring(0, delimiterIndex);
          const parent = mailboxMap.get(parentPath);
          if (parent) {
            parent.children.push(item);
            continue;
          }
        }
        rootMailboxes.push(item);
      }
      
      return rootMailboxes;
    });
    
    res.json({ success: true, mailboxes });
  } catch (error) {
    console.error('Error fetching mailboxes:', error.message, error.code || '', error.responseText || '');
    res.status(500).json({ success: false, error: `Failed to fetch mailboxes: ${getErrorDetail(error)}` });
  }
});

// Fetch emails by index range (for virtualized scrolling)
// startIndex=0 is the newest email, endIndex is exclusive
app.post('/api/emails-range', async (req, res) => {
  try {
    const { account, mailbox = 'INBOX', startIndex = 0, endIndex = 50 } = req.body;

    const result = await withConnection(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const emails = [];
        const total = client.mailbox.exists;

        if (total === 0) {
          return { emails: [], total: 0, startIndex, endIndex };
        }

        // Clamp indices to valid range
        const clampedStart = Math.max(0, Math.min(startIndex, total - 1));
        const clampedEnd = Math.min(endIndex, total);

        if (clampedStart >= clampedEnd) {
          return { emails: [], total, startIndex, endIndex };
        }

        // Convert display indices to IMAP sequence numbers
        // Display index 0 = newest = IMAP seq total
        // Display index N = IMAP seq (total - N)
        const imapStart = Math.max(1, total - clampedEnd + 1);
        const imapEnd = total - clampedStart;

        for await (const message of client.fetch(`${imapStart}:${imapEnd}`, {
          envelope: true,
          flags: true,
          bodyStructure: true,
          uid: true,
          internalDate: true,
          size: true
        })) {
          // Calculate the display index for this message
          const displayIndex = total - message.seq;

          emails.push({
            uid: message.uid,
            seq: message.seq,
            displayIndex,
            messageId: message.envelope.messageId,
            subject: message.envelope.subject || '(No Subject)',
            from: message.envelope.from?.[0] || { name: 'Unknown', address: 'unknown@unknown.com' },
            to: message.envelope.to || [],
            cc: message.envelope.cc || [],
            bcc: message.envelope.bcc || [],
            date: message.envelope.date,
            internalDate: message.internalDate,
            flags: Array.from(message.flags || []),
            size: message.size,
            hasAttachments: message.bodyStructure?.childNodes?.length > 1 || false
          });
        }

        // Sort by displayIndex (ascending = newest first in the range)
        emails.sort((a, b) => a.displayIndex - b.displayIndex);

        return { emails, total, startIndex: clampedStart, endIndex: clampedEnd };
      } finally {
        lock.release();
      }
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error fetching emails by range:', error.message, error.code || '', error.responseText || '');
    res.status(500).json({ success: false, error: `Failed to fetch emails: ${getErrorDetail(error)}` });
  }
});

// Fetch emails from a mailbox
app.post('/api/emails', async (req, res) => {
  try {
    const { account, mailbox = 'INBOX', page = 1, limit = 50 } = req.body;
    
    const result = await withConnection(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const emails = [];
        const total = client.mailbox.exists;
        
        if (total === 0) {
          return { emails: [], total: 0, page, limit, hasMore: false };
        }
        
        const start = Math.max(1, total - (page * limit) + 1);
        const end = Math.max(1, total - ((page - 1) * limit));
        
        for await (const message of client.fetch(`${start}:${end}`, {
          envelope: true,
          flags: true,
          bodyStructure: true,
          uid: true,
          internalDate: true,
          size: true
        })) {
          emails.push({
            uid: message.uid,
            seq: message.seq,
            messageId: message.envelope.messageId,
            subject: message.envelope.subject || '(No Subject)',
            from: message.envelope.from?.[0] || { name: 'Unknown', address: 'unknown@unknown.com' },
            to: message.envelope.to || [],
            cc: message.envelope.cc || [],
            bcc: message.envelope.bcc || [],
            date: message.envelope.date,
            internalDate: message.internalDate,
            flags: Array.from(message.flags || []),
            size: message.size,
            hasAttachments: message.bodyStructure?.childNodes?.length > 1 || false
          });
        }
        
        // Reverse to show newest first
        emails.reverse();
        
        return { emails, total, page, limit, hasMore: start > 1 };
      } finally {
        lock.release();
      }
    });
    
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error fetching emails:', error.message, error.code || '', error.responseText || '');
    res.status(500).json({ success: false, error: `Failed to fetch emails: ${getErrorDetail(error)}` });
  }
});

// Fetch full email content
// Fetch single email - uses priority connection to not block on background loading
app.post('/api/email/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const { account, mailbox = 'INBOX' } = req.body;

    // Use priority connection so this doesn't wait for background header loading
    const email = await withPriorityConnection(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const message = await client.fetchOne(uid, {
          source: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          uid: true,
          internalDate: true
        }, { uid: true });
        
        if (!message) {
          return null;
        }
        
        // Parse the raw email
        const parsed = await simpleParser(message.source);
        
        // Create complete email object with all metadata
        return {
          uid: message.uid,
          messageId: message.envelope.messageId,
          subject: message.envelope.subject || '(No Subject)',
          from: message.envelope.from?.[0] || { name: 'Unknown', address: 'unknown@unknown.com' },
          to: message.envelope.to || [],
          cc: message.envelope.cc || [],
          bcc: message.envelope.bcc || [],
          replyTo: message.envelope.replyTo || [],
          date: message.envelope.date,
          internalDate: message.internalDate,
          flags: Array.from(message.flags || []),
          headers: Object.fromEntries(parsed.headers),
          text: parsed.text,
          html: parsed.html,
          attachments: parsed.attachments?.map(att => ({
            filename: att.filename,
            contentType: att.contentType,
            contentDisposition: att.contentDisposition,
            size: att.size,
            contentId: att.contentId,
            content: att.content.toString('base64')
          })) || [],
          rawSource: message.source.toString('base64')
        };
      } finally {
        lock.release();
      }
    });
    
    if (!email) {
      res.status(404).json({ success: false, error: 'Email not found' });
      return;
    }
    
    res.json({ success: true, email });
  } catch (error) {
    console.error('Error fetching email:', error.message, error.code || '', error.responseText || '');
    res.status(500).json({ success: false, error: `Failed to fetch email: ${getErrorDetail(error)}` });
  }
});

// Mark email as read/unread - uses priority connection
app.post('/api/email/:uid/flags', async (req, res) => {
  try {
    const { uid } = req.params;
    const { account, mailbox = 'INBOX', flags, action = 'add' } = req.body;

    await withPriorityConnection(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        if (action === 'add') {
          await client.messageFlagsAdd(uid, flags, { uid: true });
        } else {
          await client.messageFlagsRemove(uid, flags, { uid: true });
        }
      } finally {
        lock.release();
      }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating flags:', error.message, error.code || '', error.responseText || '');
    res.status(500).json({ success: false, error: `Failed to update flags: ${getErrorDetail(error)}` });
  }
});

// Delete email (move to trash or permanent delete) - uses priority connection
app.post('/api/email/:uid/delete', async (req, res) => {
  try {
    const { uid } = req.params;
    const { account, mailbox = 'INBOX', permanent = false } = req.body;

    await withPriorityConnection(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        if (permanent) {
          await client.messageDelete(uid, { uid: true });
        } else {
          // Try different trash folder names
          const trashFolders = ['Trash', '[Gmail]/Trash', 'Deleted Items', 'Deleted'];
          let moved = false;
          
          for (const folder of trashFolders) {
            try {
              await client.messageMove(uid, folder, { uid: true });
              moved = true;
              break;
            } catch (e) {
              // Try next folder
            }
          }
          
          if (!moved) {
            // Fallback: mark as deleted
            await client.messageFlagsAdd(uid, ['\\Deleted'], { uid: true });
          }
        }
      } finally {
        lock.release();
      }
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting email:', error.message, error.code || '', error.responseText || '');
    res.status(500).json({ success: false, error: `Failed to delete email: ${getErrorDetail(error)}` });
  }
});

// Send email
app.post('/api/send', async (req, res) => {
  try {
    const { account, email } = req.body;
    
    const smtpAuth = account.authType === 'oauth2'
      ? { type: 'OAuth2', user: account.email, accessToken: account.oauth2AccessToken }
      : { user: account.email, pass: account.password };

    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort || 587,
      secure: account.smtpSecure || false,
      auth: smtpAuth,
      connectionTimeout: CONNECTION_TIMEOUT,
      greetingTimeout: CONNECTION_TIMEOUT,
      socketOptions: {
        family: 4
      }
    });
    
    const mailOptions = {
      from: `"${account.name || account.email}" <${account.email}>`,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html
    };
    
    if (email.cc) mailOptions.cc = email.cc;
    if (email.bcc) mailOptions.bcc = email.bcc;
    if (email.inReplyTo) mailOptions.inReplyTo = email.inReplyTo;
    if (email.references) mailOptions.references = email.references;
    if (email.attachments) mailOptions.attachments = email.attachments;
    
    const result = await transporter.sendMail(mailOptions);
    
    res.json({ success: true, messageId: result.messageId });
  } catch (error) {
    console.error('Error sending email:', error.message, error.code || '', error.responseText || '');
    res.status(500).json({ success: false, error: `Failed to send email: ${getErrorDetail(error)}` });
  }
});

// Search emails on server using IMAP SEARCH
app.post('/api/search', async (req, res) => {
  try {
    const { account, mailbox = 'INBOX', query, filters = {} } = req.body;

    if (!query && !filters.from && !filters.since && !filters.before) {
      return res.json({ success: true, emails: [], total: 0 });
    }

    const result = await withConnection(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        // Build IMAP search criteria
        const searchCriteria = [];

        // Text search (searches subject, from, to, body)
        if (query) {
          // IMAP TEXT search covers subject, body, and headers
          searchCriteria.push({ text: query });
        }

        // From filter
        if (filters.from) {
          searchCriteria.push({ from: filters.from });
        }

        // Date filters
        if (filters.since) {
          searchCriteria.push({ since: new Date(filters.since) });
        }
        if (filters.before) {
          searchCriteria.push({ before: new Date(filters.before) });
        }

        // Subject filter
        if (filters.subject) {
          searchCriteria.push({ subject: filters.subject });
        }

        // If no criteria, return empty (shouldn't happen due to check above)
        if (searchCriteria.length === 0) {
          return { emails: [], total: 0 };
        }

        // Combine criteria with AND
        const criteria = searchCriteria.length === 1 ? searchCriteria[0] : { and: searchCriteria };

        // Perform IMAP search
        const uids = await client.search(criteria, { uid: true });

        if (!uids || uids.length === 0) {
          return { emails: [], total: 0 };
        }

        // Limit results to prevent overwhelming the client
        const limitedUids = uids.slice(-200); // Get last 200 (most recent)

        // Fetch email headers for matching UIDs
        const emails = [];
        const uidRange = limitedUids.join(',');

        for await (const message of client.fetch(uidRange, {
          envelope: true,
          flags: true,
          bodyStructure: true,
          uid: true,
          internalDate: true,
          size: true
        }, { uid: true })) {
          emails.push({
            uid: message.uid,
            seq: message.seq,
            messageId: message.envelope.messageId,
            subject: message.envelope.subject || '(No Subject)',
            from: message.envelope.from?.[0] || { name: 'Unknown', address: 'unknown@unknown.com' },
            to: message.envelope.to || [],
            cc: message.envelope.cc || [],
            bcc: message.envelope.bcc || [],
            date: message.envelope.date,
            internalDate: message.internalDate,
            flags: Array.from(message.flags || []),
            size: message.size,
            hasAttachments: message.bodyStructure?.childNodes?.length > 1 || false,
            source: 'server-search'
          });
        }

        // Sort by date descending
        emails.sort((a, b) => new Date(b.date) - new Date(a.date));

        return { emails, total: uids.length };
      } finally {
        lock.release();
      }
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error searching emails:', error.message, error.code || '', error.responseText || '');
    res.status(500).json({ success: false, error: `Failed to search emails: ${getErrorDetail(error)}` });
  }
});

// Test account connection
app.post('/api/test-connection', async (req, res) => {
  try {
    const { account } = req.body;
    const auth = buildImapAuth(account);

    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort || 993,
      secure: account.imapSecure !== false,
      auth,
      logger: false,
      connectTimeout: CONNECTION_TIMEOUT,
      greetingTimeout: CONNECTION_TIMEOUT,
      socketOptions: {
        family: 4
      }
    });

    await client.connect();
    await client.logout();

    res.json({ success: true, message: 'Connection successful' });
  } catch (error) {
    console.error('Connection test failed:', error.message, error.code || '', error.responseText || '');
    res.status(400).json({ success: false, error: `Connection test failed: ${getErrorDetail(error)}` });
  }
});

// Disconnect account
app.post('/api/disconnect', async (req, res) => {
  try {
    const { account } = req.body;
    const key = `${account.email}-${account.imapHost}`;
    
    if (connections.has(key)) {
      const client = connections.get(key);
      connections.delete(key);
      try {
        await client.logout();
      } catch (e) {
        // Ignore
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    res.json({ success: true }); // Ignore errors on disconnect
  }
});

// --- OAuth2 Endpoints ---

// PKCE helpers
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Store pending OAuth flows (state -> { codeVerifier, resolve, reject })
const pendingOAuthFlows = new Map();
// Callback server instance
let callbackServer = null;

function ensureCallbackServer() {
  if (callbackServer) return;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${MICROSOFT_OAUTH.callbackPort}`);

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');

      // Serve a response page
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (error) {
        res.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
          <div style="text-align:center"><h2>Authentication Failed</h2><p>${errorDescription || error}</p><p>You can close this window.</p></div></body></html>`);
        const pending = pendingOAuthFlows.get(state);
        if (pending) {
          pending.reject(new Error(errorDescription || error));
          pendingOAuthFlows.delete(state);
        }
      } else if (code && state) {
        res.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
          <div style="text-align:center"><h2>Sign-in Successful</h2><p>You can close this window and return to MailVault.</p></div></body></html>`);
        const pending = pendingOAuthFlows.get(state);
        if (pending) {
          pending.resolve(code);
          pendingOAuthFlows.delete(state);
        }
      } else {
        res.end('<html><body>Invalid request</body></html>');
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(MICROSOFT_OAUTH.callbackPort, '127.0.0.1', () => {
    console.log(`OAuth callback server listening on port ${MICROSOFT_OAUTH.callbackPort}`);
  });

  server.on('error', (err) => {
    console.error('OAuth callback server error:', err.message);
    callbackServer = null;
  });

  callbackServer = server;
}

// GET /api/oauth2/auth-url — generate authorization URL with PKCE
app.get('/api/oauth2/auth-url', (req, res) => {
  try {
    const { clientId } = getMicrosoftCredentials();
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Ensure callback server is running
    ensureCallbackServer();

    // Create a promise that will be resolved by the callback server
    const codePromise = new Promise((resolve, reject) => {
      pendingOAuthFlows.set(state, { codeVerifier, resolve, reject });
      // Timeout after 5 minutes
      setTimeout(() => {
        if (pendingOAuthFlows.has(state)) {
          pendingOAuthFlows.delete(state);
          reject(new Error('OAuth flow timed out'));
        }
      }, 5 * 60 * 1000);
    });

    // Store the promise for the exchange endpoint
    pendingOAuthFlows.get(state).codePromise = codePromise;

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: MICROSOFT_OAUTH.redirectUri,
      scope: MICROSOFT_OAUTH.scopes.join(' '),
      response_mode: 'query',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    // Pre-fill the email on the Microsoft login page
    if (req.query.login_hint) {
      params.append('login_hint', req.query.login_hint);
    }

    const authUrl = `${MICROSOFT_OAUTH.authEndpoint}?${params.toString()}`;

    res.json({ success: true, authUrl, state });
  } catch (error) {
    console.error('Error generating auth URL:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/oauth2/exchange — wait for callback and exchange code for tokens
app.post('/api/oauth2/exchange', async (req, res) => {
  try {
    const { state } = req.body;
    const pending = pendingOAuthFlows.get(state);

    if (!pending) {
      return res.status(400).json({ success: false, error: 'No pending OAuth flow for this state' });
    }

    // Wait for the authorization code from the callback server
    const code = await pending.codePromise;
    const { clientId, clientSecret } = getMicrosoftCredentials();

    // Exchange code for tokens
    const tokenParams = new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: MICROSOFT_OAUTH.redirectUri,
      code_verifier: pending.codeVerifier,
    });

    if (clientSecret) {
      tokenParams.append('client_secret', clientSecret);
    }

    console.log('[OAuth2] Exchanging code for tokens...');

    const tokenResponse = await fetch(MICROSOFT_OAUTH.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      console.error('[OAuth2] Token error:', tokenData.error_description || tokenData.error);
      throw new Error(tokenData.error_description || tokenData.error);
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresAt = Date.now() + (tokenData.expires_in * 1000);

    res.json({
      success: true,
      accessToken,
      refreshToken,
      expiresAt,
    });
  } catch (error) {
    console.error('OAuth exchange error:', error.message);
    res.status(500).json({ success: false, error: `OAuth exchange failed: ${error.message}` });
  }
});

// POST /api/oauth2/refresh — refresh an access token
app.post('/api/oauth2/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ success: false, error: 'Missing refresh token' });
    }

    const { clientId, clientSecret } = getMicrosoftCredentials();

    const tokenParams = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: MICROSOFT_OAUTH.scopes.join(' '),
    });

    if (clientSecret) {
      tokenParams.append('client_secret', clientSecret);
    }

    const tokenResponse = await fetch(MICROSOFT_OAUTH.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error);
    }

    const expiresAt = Date.now() + (tokenData.expires_in * 1000);

    res.json({
      success: true,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || refreshToken,
      expiresAt,
    });
  } catch (error) {
    console.error('OAuth refresh error:', error.message);
    res.status(500).json({ success: false, error: `Token refresh failed: ${error.message}` });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', connections: connections.size });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Mail server running on 127.0.0.1:${PORT}`);
});

// Cleanup stale connections periodically
setInterval(() => {
  for (const [key, client] of connections.entries()) {
    if (!client.usable) {
      console.log(`Removing stale connection: ${key}`);
      connections.delete(key);
      try {
        client.logout();
      } catch (e) {
        // Ignore
      }
    }
  }
}, 60000); // Every minute

// Graceful shutdown
function cleanupAndExit() {
  console.log('Shutting down...');
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
  }
  for (const [key, client] of connections.entries()) {
    try {
      client.logout();
    } catch (e) {
      // Ignore
    }
  }
  process.exit(0);
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

// Prevent unhandled rejections from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});
