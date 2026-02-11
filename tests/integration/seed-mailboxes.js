/**
 * Seed both test mailboxes with 500 realistic emails (250 each direction).
 * Run with: node tests/integration/seed-mailboxes.js
 */
import { ImapFlow } from 'imapflow';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env.test');
const envContent = readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envContent.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const [key, ...rest] = l.split('=');
    return [key.trim(), rest.join('=').trim()];
  })
);

const LUKE = { email: env.TEST_EMAIL, password: env.TEST_PASSWORD };
const VADER = { email: env.TEST_EMAIL2, password: env.TEST_PASSWORD2 };
const IMAP_HOST = env.IMAP_HOST;
const IMAP_PORT = Number(env.IMAP_PORT) || 993;

function createImap(account) {
  return new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false, connectTimeout: 30000, greetingTimeout: 30000, socketTimeout: 60000,
  });
}

// Realistic email subjects
const subjects = [
  'Q4 Revenue Report — Final Numbers',
  'Re: Project Falcon timeline update',
  'Meeting notes from Monday standup',
  'Invitation: Team offsite Dec 15-17',
  'Your flight confirmation — LAX to JFK',
  'Invoice #4821 — Due January 15',
  'New design mockups for review',
  'Re: Quick question about the API',
  'Weekly digest: Engineering updates',
  'Shipping confirmation: Order #98234',
  'Re: Lunch tomorrow?',
  'Updated contract — please sign',
  'Photos from the holiday party',
  'Security alert: New login detected',
  'Re: Bug in checkout flow',
  'Board meeting agenda — January',
  'Your subscription renewal',
  'Feedback on the new homepage',
  'Re: Can you review this PR?',
  'Travel itinerary for next week',
  'Quarterly OKR check-in',
  'Re: Server outage postmortem',
  'Welcome to the team!',
  'Action required: Update your password',
  'Re: Feature request from customer',
  'Sprint retrospective notes',
  'New hire onboarding checklist',
  'Re: Database migration plan',
  'Expense report — November',
  'Product launch timeline',
  'Re: Holiday schedule reminder',
  'Architecture decision record #12',
  'Customer feedback summary',
  'Re: Deployment to production',
  'Team building event — Save the date',
  'Performance review — Self assessment',
  'Re: Slack integration proposal',
  'Monthly infrastructure costs',
  'Design system v2.0 proposal',
  'Re: Interview feedback — Senior Engineer',
];

const bodies = {
  plain: (subj, i) => `Hi,\n\nFollowing up on "${subj}".\n\nHere are the key points:\n- Item ${i * 3 + 1}: Review completed\n- Item ${i * 3 + 2}: Pending approval\n- Item ${i * 3 + 3}: In progress\n\nLet me know if you have questions.\n\nBest regards`,
  html: (subj, i) => `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="padding: 20px; border-bottom: 2px solid #6366f1;">
    <h2 style="margin: 0; color: #1a1a2e;">${subj}</h2>
  </div>
  <div style="padding: 20px; line-height: 1.6;">
    <p>Hi there,</p>
    <p>I wanted to share an update on this. Here's where we stand:</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr style="background: #f8f9fa;">
        <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Task</th>
        <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Status</th>
        <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Priority</th>
      </tr>
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #dee2e6;">Phase ${i % 4 + 1} review</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #dee2e6;"><span style="color: #22c55e;">✓ Complete</span></td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #dee2e6;">High</td>
      </tr>
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #dee2e6;">Stakeholder signoff</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #dee2e6;"><span style="color: #f59e0b;">⏳ In progress</span></td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #dee2e6;">Medium</td>
      </tr>
      <tr>
        <td style="padding: 8px 12px;">Final deployment</td>
        <td style="padding: 8px 12px;"><span style="color: #94a3b8;">○ Pending</span></td>
        <td style="padding: 8px 12px;">Low</td>
      </tr>
    </table>
    <p>The deadline is coming up on <strong>${new Date(Date.now() + (i + 1) * 86400000).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</strong>. Please review and let me know your thoughts.</p>
    <p style="margin-top: 24px;">Thanks,<br><span style="color: #6366f1;">The Team</span></p>
  </div>
</div>`,
};

// 1x1 PNG for attachments
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';

function buildMessage(index, from, to) {
  const subj = subjects[index % subjects.length];
  const date = new Date(Date.now() - (500 - index) * 3600000).toUTCString();
  const msgId = `<seed-${Date.now()}-${index}@forceunwrap.com>`;
  const types = ['plain', 'html', 'html', 'html-attachment', 'html-multi-attachment'];
  const type = types[index % types.length];
  const boundary = `----bnd-${Date.now()}-${index}`;

  const headers = [
    `From: "${from.email.split('@')[0]}" <${from.email}>`,
    `To: ${to.email}`,
    `Subject: ${subj}`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
  ];

  if (type === 'plain') {
    headers.push('Content-Type: text/plain; charset="utf-8"');
    return [...headers, '', bodies.plain(subj, index)].join('\r\n');
  }

  if (type === 'html') {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      ...headers, '',
      `--${boundary}`, 'Content-Type: text/plain; charset="utf-8"', '', bodies.plain(subj, index),
      `--${boundary}`, 'Content-Type: text/html; charset="utf-8"', '', bodies.html(subj, index),
      `--${boundary}--`,
    ].join('\r\n');
  }

  if (type === 'html-attachment') {
    const mixedBnd = `----mixed-${Date.now()}-${index}`;
    const altBnd = `----alt-${Date.now()}-${index}`;
    const fileContent = Buffer.from(`Report data for "${subj}"\nGenerated: ${new Date().toISOString()}\nIndex: ${index}`).toString('base64');
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBnd}"`);
    return [
      ...headers, '',
      `--${mixedBnd}`,
      `Content-Type: multipart/alternative; boundary="${altBnd}"`, '',
      `--${altBnd}`, 'Content-Type: text/plain; charset="utf-8"', '', bodies.plain(subj, index),
      `--${altBnd}`, 'Content-Type: text/html; charset="utf-8"', '', bodies.html(subj, index),
      `--${altBnd}--`,
      `--${mixedBnd}`,
      `Content-Type: application/pdf; name="report-${index}.pdf"`,
      `Content-Disposition: attachment; filename="report-${index}.pdf"`,
      'Content-Transfer-Encoding: base64', '',
      fileContent,
      `--${mixedBnd}--`,
    ].join('\r\n');
  }

  // html-multi-attachment
  const mixedBnd = `----mixed-${Date.now()}-${index}`;
  const altBnd = `----alt-${Date.now()}-${index}`;
  const csvContent = Buffer.from(`Name,Value,Status\nAlpha,${index},Active\nBeta,${index + 1},Pending`).toString('base64');
  const jsonContent = Buffer.from(JSON.stringify({ id: index, subject: subj, timestamp: Date.now() }, null, 2)).toString('base64');
  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBnd}"`);
  return [
    ...headers, '',
    `--${mixedBnd}`,
    `Content-Type: multipart/alternative; boundary="${altBnd}"`, '',
    `--${altBnd}`, 'Content-Type: text/plain; charset="utf-8"', '', bodies.plain(subj, index),
    `--${altBnd}`, 'Content-Type: text/html; charset="utf-8"', '', bodies.html(subj, index),
    `--${altBnd}--`,
    `--${mixedBnd}`,
    `Content-Type: text/csv; name="data-${index}.csv"`,
    `Content-Disposition: attachment; filename="data-${index}.csv"`,
    'Content-Transfer-Encoding: base64', '',
    csvContent,
    `--${mixedBnd}`,
    `Content-Type: application/json; name="metadata-${index}.json"`,
    `Content-Disposition: attachment; filename="metadata-${index}.json"`,
    'Content-Transfer-Encoding: base64', '',
    jsonContent,
    `--${mixedBnd}`,
    `Content-Type: image/png; name="chart-${index}.png"`,
    `Content-Disposition: attachment; filename="chart-${index}.png"`,
    'Content-Transfer-Encoding: base64', '',
    pngBase64,
    `--${mixedBnd}--`,
  ].join('\r\n');
}

async function seed() {
  console.log('Seeding 500 emails (250 Luke→Vader, 250 Vader→Luke)...\n');

  // Inject into Luke's INBOX (emails "from" Vader)
  console.log(`[Luke] Injecting 250 emails into ${LUKE.email}...`);
  const lukeClient = createImap(LUKE);
  await lukeClient.connect();
  for (let i = 0; i < 250; i++) {
    const raw = buildMessage(i, VADER, LUKE);
    const flags = i % 3 === 0 ? [] : ['\\Seen']; // ~1/3 unread
    await lukeClient.append('INBOX', raw, flags, new Date(Date.now() - (250 - i) * 3600000));
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/250`);
  }
  await lukeClient.logout();
  console.log('[Luke] Done.\n');

  // Inject into Vader's INBOX (emails "from" Luke)
  console.log(`[Vader] Injecting 250 emails into ${VADER.email}...`);
  const vaderClient = createImap(VADER);
  await vaderClient.connect();
  for (let i = 250; i < 500; i++) {
    const raw = buildMessage(i, LUKE, VADER);
    const flags = i % 3 === 0 ? [] : ['\\Seen'];
    await vaderClient.append('INBOX', raw, flags, new Date(Date.now() - (500 - i) * 3600000));
    if ((i - 249) % 50 === 0) console.log(`  ${i - 249}/250`);
  }
  await vaderClient.logout();
  console.log('[Vader] Done.\n');

  console.log('✓ 500 emails seeded successfully.');
  console.log('  Luke inbox: 250 emails from Vader (mixed plain/html/attachments)');
  console.log('  Vader inbox: 250 emails from Luke (mixed plain/html/attachments)');
}

seed().catch(e => { console.error('Seed failed:', e); process.exit(1); });
