let mysql;
try {
  mysql = require('mysql2/promise');
} catch (e) {
  mysql = null;
  console.error('mysql2 not installed:', e.message);
}

let pool;

function getPool() {
  if (!mysql) throw new Error('mysql2 module not available');
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 10000
    });
  }
  return pool;
}

// Create tables if they don't exist
async function initDatabase() {
  const db = getPool();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS votes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ip_hash VARCHAR(64) NOT NULL,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_ip (ip_hash)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS features (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS feature_votes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      feature_id INT NOT NULL,
      ip_hash VARCHAR(64) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_feature_ip (feature_id, ip_hash)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      ip_hash VARCHAR(64),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      category VARCHAR(100) DEFAULT 'other',
      message TEXT NOT NULL,
      ip_hash VARCHAR(64),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Privacy-safe aggregate metrics: one row per (day, event), count only.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS metrics_daily (
      day DATE NOT NULL,
      event VARCHAR(64) NOT NULL,
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (day, event)
    )
  `);

  // Billing tables
  await db.execute(`
    CREATE TABLE IF NOT EXISTS billing_customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      stripe_customer_id VARCHAR(255) NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      billing_customer_id INT NOT NULL,
      stripe_subscription_id VARCHAR(255) NOT NULL UNIQUE,
      stripe_price_id VARCHAR(255),
      price_interval VARCHAR(20),
      status VARCHAR(50) NOT NULL,
      premium_access BOOLEAN DEFAULT FALSE,
      current_period_start DATETIME,
      current_period_end DATETIME,
      cancel_at_period_end BOOLEAN DEFAULT FALSE,
      canceled_at DATETIME NULL,
      latest_invoice_status VARCHAR(50),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_customer (billing_customer_id),
      INDEX idx_status (status)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS processed_stripe_events (
      event_id VARCHAR(255) PRIMARY KEY,
      event_type VARCHAR(100) NOT NULL,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS billing_clients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      billing_customer_id INT NOT NULL,
      client_id VARCHAR(255) NOT NULL,
      client_name VARCHAR(255),
      platform VARCHAR(50),
      app_version VARCHAR(50),
      os_version VARCHAR(100),
      first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_customer_client (billing_customer_id, client_id),
      INDEX idx_customer (billing_customer_id),
      INDEX idx_last_seen (last_seen_at)
    )
  `);

  // Extra Stripe customers that belong to an existing billing_customers row (a returning
  // buyer paying through the web checkout). The row keeps its owner; these only point at it.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS billing_customer_aliases (
      stripe_customer_id VARCHAR(255) PRIMARY KEY,
      billing_customer_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_customer (billing_customer_id)
    )
  `);

  // One-time tokens that turn a paid web checkout into an activated install.
  // Only the SHA-256 of the token is stored; used_at is the single-use lock.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS billing_activation_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token_hash CHAR(64) NOT NULL UNIQUE,
      stripe_session_id VARCHAR(255) NOT NULL,
      billing_customer_id INT NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_session (stripe_session_id),
      INDEX idx_expires (expires_at)
    )
  `);

  // Email sign-in codes for the phone app. Only the SHA-256 of the code is stored.
  // Times are epoch milliseconds. Unknown addresses get a row too (never mailed), so
  // verifying cannot reveal whether an address is a customer.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS billing_signin_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      code_hash CHAR(64) NOT NULL,
      expires_at BIGINT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      used_at BIGINT NULL,
      created_at BIGINT NOT NULL,
      INDEX idx_email (email, id),
      INDEX idx_expires (expires_at)
    )
  `);

  // App Store / Google Play subscriptions of phone installs (store-billing.js). One row per
  // store subscription: Apple originalTransactionId, or the root of a Play purchaseToken's
  // linkedPurchaseToken chain (latest_token is the newest token of that chain). Kept current
  // by the verify endpoints and the store webhooks. Times are epoch milliseconds.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS store_subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      platform ENUM('apple','google') NOT NULL,
      original_id VARCHAR(512) CHARACTER SET ascii NOT NULL,
      install_id CHAR(36) NULL,
      product_id VARCHAR(255) NOT NULL,
      expires_at BIGINT NOT NULL,
      status ENUM('active','expired','revoked','refunded','on_hold','grace') NOT NULL,
      environment VARCHAR(20) NOT NULL,
      latest_token VARCHAR(512) CHARACTER SET ascii NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE KEY unique_platform_original (platform, original_id),
      INDEX idx_latest_token (platform, latest_token),
      INDEX idx_install (install_id)
    )
  `);

  // Installs a store subscription serves (restore on a new phone joins the set). store-billing.js
  // refuses a restore into a set of 5 live installs (409) and evicts nobody; a row not seen
  // for 30 days is pruned when the set is read.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS store_subscription_installs (
      subscription_id INT NOT NULL,
      install_id CHAR(36) NOT NULL,
      last_seen_at BIGINT NOT NULL,
      PRIMARY KEY (subscription_id, install_id)
    )
  `);

  // Store notifications already applied (ASSN notificationUUID, Pub/Sub messageId).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS processed_store_events (
      event_id VARCHAR(255) PRIMARY KEY,
      platform ENUM('apple','google') NOT NULL,
      processed_at BIGINT NOT NULL
    )
  `);

  // Seed default features if table is empty
  const [rows] = await db.execute('SELECT COUNT(*) as count FROM features');
  if (rows[0].count === 0) {
    const features = [
      [1, 'Windows Support', 'Native Windows application'],
      [2, 'Linux Support', 'Native Linux application'],
      [3, 'Calendar Integration', 'View and manage calendar events from emails'],
      [4, 'Email Templates', 'Save and reuse email templates'],
      [5, 'Smart Folders', 'Auto-organize emails with custom rules'],
      [6, 'Email Scheduling', 'Schedule emails to send later'],
      [7, 'Multiple Account Sync', 'Sync multiple email accounts simultaneously'],
      [8, 'Email Encryption', 'PGP/GPG encryption support'],
      [9, 'Mobile Companion App', 'Access your local archive from mobile'],
      [10, 'Cloud Backup Option', 'Optional encrypted backup to your own cloud storage'],
    ];
    for (const [id, name, desc] of features) {
      await db.execute('INSERT INTO features (id, name, description) VALUES (?, ?, ?)', [id, name, desc]);
    }
    console.log('Seeded default features');
  }

  console.log('Database tables initialized');
}

module.exports = { getPool, initDatabase };
