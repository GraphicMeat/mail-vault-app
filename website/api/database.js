const Database = require('better-sqlite3');
const path = require('path');

// Create database in the api directory
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// ===========================================
// Create Tables
// ===========================================

db.exec(`
  -- "I Want This" votes
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_votes_ip_hash ON votes(ip_hash);

  -- Features for voting
  CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Feature votes
  CREATE TABLE IF NOT EXISTS feature_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL,
    ip_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE,
    UNIQUE(feature_id, ip_hash)
  );

  CREATE INDEX IF NOT EXISTS idx_feature_votes_feature ON feature_votes(feature_id);
  CREATE INDEX IF NOT EXISTS idx_feature_votes_ip ON feature_votes(ip_hash);

  -- Newsletter subscribers
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    ip_hash TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);

  -- Contact form submissions
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    category TEXT DEFAULT 'other',
    message TEXT NOT NULL,
    ip_hash TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at);
`);

// ===========================================
// Seed Default Features
// ===========================================

const featureCount = db.prepare('SELECT COUNT(*) as count FROM features').get();

if (featureCount.count === 0) {
  console.log('Seeding default features...');

  const defaultFeatures = [
    { name: 'Windows Support', description: 'Native Windows application' },
    { name: 'Linux Support', description: 'Native Linux application' },
    { name: 'Calendar Integration', description: 'View and manage calendar events from emails' },
    { name: 'Email Templates', description: 'Save and reuse email templates' },
    { name: 'Smart Folders', description: 'Auto-organize emails with custom rules' },
    { name: 'Email Scheduling', description: 'Schedule emails to send later' },
    { name: 'Multiple Account Sync', description: 'Sync multiple email accounts simultaneously' },
    { name: 'Email Encryption', description: 'PGP/GPG encryption support' },
    { name: 'Mobile Companion App', description: 'Access your local archive from mobile' },
    { name: 'Cloud Backup Option', description: 'Optional encrypted backup to your own cloud storage' },
  ];

  const insert = db.prepare(`
    INSERT INTO features (name, description) VALUES (?, ?)
  `);

  for (const feature of defaultFeatures) {
    insert.run(feature.name, feature.description);
  }

  console.log(`Seeded ${defaultFeatures.length} features`);
}

console.log(`Database initialized at: ${dbPath}`);

module.exports = db;
