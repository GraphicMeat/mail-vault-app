const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// Email transporter (configured via env vars)
const transporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: (parseInt(process.env.SMTP_PORT) || 465) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
}) : null;

// ===========================================
// Middleware
// ===========================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS - allow requests from your website
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*', // Set to your domain in production
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Parse JSON bodies
app.use(express.json());

// Trust proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Stricter rate limit for voting
const voteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // limit each IP to 10 votes per hour
  message: { error: 'Too many votes, please try again later.' }
});

// ===========================================
// Helper: Get client IP
// ===========================================
function getClientIP(req) {
  return req.ip ||
         req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.connection?.remoteAddress ||
         'unknown';
}

// ===========================================
// Serve Static Website
// ===========================================
app.use(express.static(path.join(__dirname, '..'), {
  index: 'index.html'
}));

// ===========================================
// API Routes
// ===========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// -------------------------------------------
// "I Want This" Votes
// -------------------------------------------

// Get total vote count
app.get('/api/votes', (req, res) => {
  try {
    const result = db.prepare('SELECT COUNT(*) as count FROM votes').get();
    res.json({ count: result.count });
  } catch (error) {
    console.error('Error getting votes:', error);
    res.status(500).json({ error: 'Failed to get vote count' });
  }
});

// Submit a vote
app.post('/api/votes', voteLimiter, (req, res) => {
  try {
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'] || '';

    // Check if already voted (by IP)
    const existing = db.prepare('SELECT id FROM votes WHERE ip_hash = ?').get(hashIP(ip));

    if (existing) {
      const result = db.prepare('SELECT COUNT(*) as count FROM votes').get();
      return res.json({ count: result.count, alreadyVoted: true });
    }

    // Insert new vote
    db.prepare(`
      INSERT INTO votes (ip_hash, user_agent, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(hashIP(ip), userAgent);

    const result = db.prepare('SELECT COUNT(*) as count FROM votes').get();
    res.json({ count: result.count, alreadyVoted: false });
  } catch (error) {
    console.error('Error submitting vote:', error);
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

// -------------------------------------------
// Feature Voting
// -------------------------------------------

// Get all features with vote counts
app.get('/api/features', (req, res) => {
  try {
    const features = db.prepare(`
      SELECT
        f.id,
        f.name,
        f.description,
        COUNT(fv.id) as votes
      FROM features f
      LEFT JOIN feature_votes fv ON f.id = fv.feature_id
      GROUP BY f.id
      ORDER BY votes DESC, f.id ASC
    `).all();

    res.json(features);
  } catch (error) {
    console.error('Error getting features:', error);
    res.status(500).json({ error: 'Failed to get features' });
  }
});

// Vote for a feature
app.post('/api/features/:id/vote', voteLimiter, (req, res) => {
  try {
    const featureId = parseInt(req.params.id);
    const ip = getClientIP(req);

    // Check if feature exists
    const feature = db.prepare('SELECT id FROM features WHERE id = ?').get(featureId);
    if (!feature) {
      return res.status(404).json({ error: 'Feature not found' });
    }

    // Check if already voted for this feature (by IP)
    const existing = db.prepare(`
      SELECT id FROM feature_votes
      WHERE feature_id = ? AND ip_hash = ?
    `).get(featureId, hashIP(ip));

    if (existing) {
      return res.json({ success: true, alreadyVoted: true });
    }

    // Insert vote
    db.prepare(`
      INSERT INTO feature_votes (feature_id, ip_hash, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(featureId, hashIP(ip));

    res.json({ success: true, alreadyVoted: false });
  } catch (error) {
    console.error('Error voting for feature:', error);
    res.status(500).json({ error: 'Failed to vote for feature' });
  }
});

// -------------------------------------------
// Newsletter Subscription
// -------------------------------------------

app.post('/api/subscribe', (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    // Check if already subscribed
    const existing = db.prepare('SELECT id FROM subscribers WHERE email = ?').get(email.toLowerCase());

    if (existing) {
      return res.json({ success: true, message: 'Already subscribed' });
    }

    // Insert subscriber
    db.prepare(`
      INSERT INTO subscribers (email, ip_hash, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(email.toLowerCase(), hashIP(getClientIP(req)));

    res.json({ success: true, message: 'Subscribed successfully' });
  } catch (error) {
    console.error('Error subscribing:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// -------------------------------------------
// Contact Form
// -------------------------------------------

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, category, message } = req.body;

    // Validation
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    // Insert contact message
    db.prepare(`
      INSERT INTO contacts (name, email, category, message, ip_hash, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(name, email.toLowerCase(), category || 'other', message, hashIP(getClientIP(req)));

    // Send email notification
    if (transporter && process.env.NOTIFY_EMAIL) {
      transporter.sendMail({
        from: `"MailVault Contact" <${process.env.SMTP_USER}>`,
        to: process.env.NOTIFY_EMAIL,
        replyTo: email,
        subject: `[MailVault] ${category || 'general'}: New message from ${name}`,
        text: `Name: ${name}\nEmail: ${email}\nCategory: ${category || 'general'}\n\nMessage:\n${message}`,
        html: `<p><strong>Name:</strong> ${name}</p>
<p><strong>Email:</strong> ${email}</p>
<p><strong>Category:</strong> ${category || 'general'}</p>
<hr>
<p>${message.replace(/\n/g, '<br>')}</p>`
      }).catch(err => console.error('Failed to send notification email:', err));
    }

    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    console.error('Error submitting contact:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ===========================================
// Admin Routes (protected - add auth in production)
// ===========================================

// Get all subscribers (for export)
app.get('/api/admin/subscribers', (req, res) => {
  // TODO: Add authentication
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const subscribers = db.prepare(`
      SELECT id, email, created_at
      FROM subscribers
      ORDER BY created_at DESC
    `).all();

    res.json(subscribers);
  } catch (error) {
    console.error('Error getting subscribers:', error);
    res.status(500).json({ error: 'Failed to get subscribers' });
  }
});

// Get all contact messages
app.get('/api/admin/contacts', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const contacts = db.prepare(`
      SELECT id, name, email, category, message, created_at
      FROM contacts
      ORDER BY created_at DESC
    `).all();

    res.json(contacts);
  } catch (error) {
    console.error('Error getting contacts:', error);
    res.status(500).json({ error: 'Failed to get contacts' });
  }
});

// ===========================================
// Utilities
// ===========================================

// Simple hash for IP (for privacy - don't store raw IPs)
function hashIP(ip) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(ip + process.env.IP_SALT || 'mailvault-salt').digest('hex').substring(0, 32);
}

// Email validation
function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// ===========================================
// Start Server
// ===========================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════╗
║   MailVault Website API                    ║
║   Running on http://0.0.0.0:${PORT}            ║
╚════════════════════════════════════════════╝
  `);
});

module.exports = app;
