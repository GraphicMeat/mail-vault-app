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
