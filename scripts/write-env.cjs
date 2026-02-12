// Writes build-time env vars to website/api/.env for runtime use
const fs = require('fs');
const path = require('path');

const envVars = [
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASS', 'DB_NAME',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
  'NOTIFY_EMAIL', 'ADMIN_KEY', 'IP_SALT', 'CORS_ORIGIN'
];

const lines = envVars
  .filter(key => process.env[key])
  .map(key => `${key}=${process.env[key]}`);

if (lines.length > 0) {
  const envPath = path.join(__dirname, '..', 'website', 'api', '.env');
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
  console.log(`Wrote ${lines.length} env vars to website/api/.env`);
} else {
  console.log('No env vars found to write (this is normal for local dev)');
}
