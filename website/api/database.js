const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'data.json');

// Default data structure
const defaultData = {
  votes: [],
  features: [
    { id: 1, name: 'Windows Support', description: 'Native Windows application' },
    { id: 2, name: 'Linux Support', description: 'Native Linux application' },
    { id: 3, name: 'Calendar Integration', description: 'View and manage calendar events from emails' },
    { id: 4, name: 'Email Templates', description: 'Save and reuse email templates' },
    { id: 5, name: 'Smart Folders', description: 'Auto-organize emails with custom rules' },
    { id: 6, name: 'Email Scheduling', description: 'Schedule emails to send later' },
    { id: 7, name: 'Multiple Account Sync', description: 'Sync multiple email accounts simultaneously' },
    { id: 8, name: 'Email Encryption', description: 'PGP/GPG encryption support' },
    { id: 9, name: 'Mobile Companion App', description: 'Access your local archive from mobile' },
    { id: 10, name: 'Cloud Backup Option', description: 'Optional encrypted backup to your own cloud storage' },
  ],
  feature_votes: [],
  subscribers: [],
  contacts: [],
  _nextId: { votes: 1, feature_votes: 1, subscribers: 1, contacts: 1 }
};

// Load or initialize
function loadData() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading database, using defaults:', e.message);
  }
  return JSON.parse(JSON.stringify(defaultData));
}

function saveData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();
if (!data._nextId) {
  data._nextId = { votes: 1, feature_votes: 1, subscribers: 1, contacts: 1 };
}
saveData(data);

// Expose a simple query interface matching what server.js expects
const db = {
  prepare(sql) {
    return {
      get(...params) { return execQuery(sql, params, 'get'); },
      all(...params) { return execQuery(sql, params, 'all'); },
      run(...params) { return execQuery(sql, params, 'run'); }
    };
  }
};

function execQuery(sql, params, mode) {
  const s = sql.trim().replace(/\s+/g, ' ');

  // SELECT COUNT(*) as count FROM votes
  if (s.includes('COUNT(*)') && s.includes('FROM votes')) {
    return { count: data.votes.length };
  }

  // SELECT id FROM votes WHERE ip_hash = ?
  if (s.includes('FROM votes WHERE ip_hash')) {
    return data.votes.find(v => v.ip_hash === params[0]) || null;
  }

  // INSERT INTO votes
  if (s.includes('INSERT INTO votes')) {
    const id = data._nextId.votes++;
    data.votes.push({ id, ip_hash: params[0], user_agent: params[1], created_at: params[2] || new Date().toISOString() });
    saveData(data);
    return { changes: 1 };
  }

  // SELECT features with vote counts
  if (s.includes('FROM features f') && s.includes('LEFT JOIN')) {
    return data.features.map(f => ({
      id: f.id,
      name: f.name,
      description: f.description,
      votes: data.feature_votes.filter(fv => fv.feature_id === f.id).length
    })).sort((a, b) => b.votes - a.votes || a.id - b.id);
  }

  // SELECT id FROM features WHERE id = ?
  if (s.includes('FROM features WHERE id')) {
    return data.features.find(f => f.id === params[0]) || null;
  }

  // SELECT id FROM feature_votes WHERE feature_id = ? AND ip_hash = ?
  if (s.includes('FROM feature_votes') && s.includes('WHERE')) {
    return data.feature_votes.find(fv => fv.feature_id === params[0] && fv.ip_hash === params[1]) || null;
  }

  // INSERT INTO feature_votes
  if (s.includes('INSERT INTO feature_votes')) {
    const id = data._nextId.feature_votes++;
    data.feature_votes.push({ id, feature_id: params[0], ip_hash: params[1], created_at: params[2] || new Date().toISOString() });
    saveData(data);
    return { changes: 1 };
  }

  // SELECT id FROM subscribers WHERE email = ?
  if (s.includes('FROM subscribers WHERE email')) {
    return data.subscribers.find(sub => sub.email === params[0]) || null;
  }

  // INSERT INTO subscribers
  if (s.includes('INSERT INTO subscribers')) {
    const id = data._nextId.subscribers++;
    data.subscribers.push({ id, email: params[0], ip_hash: params[1], created_at: params[2] || new Date().toISOString() });
    saveData(data);
    return { changes: 1 };
  }

  // INSERT INTO contacts
  if (s.includes('INSERT INTO contacts')) {
    const id = data._nextId.contacts++;
    data.contacts.push({ id, name: params[0], email: params[1], category: params[2], message: params[3], ip_hash: params[4], created_at: params[5] || new Date().toISOString() });
    saveData(data);
    return { changes: 1 };
  }

  // SELECT subscribers (admin)
  if (s.includes('FROM subscribers') && s.includes('ORDER BY')) {
    return data.subscribers.map(({ id, email, created_at }) => ({ id, email, created_at })).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // SELECT contacts (admin)
  if (s.includes('FROM contacts') && s.includes('ORDER BY')) {
    return data.contacts.map(({ id, name, email, category, message, created_at }) => ({ id, name, email, category, message, created_at })).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // SELECT COUNT(*) as count FROM features (seed check)
  if (s.includes('COUNT(*)') && s.includes('FROM features')) {
    return { count: data.features.length };
  }

  return mode === 'all' ? [] : null;
}

console.log(`Database initialized at: ${DB_FILE}`);

module.exports = db;
