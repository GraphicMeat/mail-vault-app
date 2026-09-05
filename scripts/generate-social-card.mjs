// Render the site's code-defined social card. SHARP_MODULE may point to a bundled
// sharp installation; otherwise the script uses a locally installed sharp package.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const root = resolve(import.meta.dirname, '..');
const icon = await sharp(readFileSync(resolve(root, 'website/icon-128.webp'))).png().toBuffer();
const app = await sharp(readFileSync(resolve(root, 'website/screenshots/thread-view-1440.webp'))).resize(730).png().toBuffer();
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><clipPath id="app"><rect x="648" y="122" width="730" height="471" rx="12"/></clipPath></defs>
<rect width="1200" height="630" fill="#fafaf8"/>
<rect x="622" y="96" width="640" height="523" rx="24" fill="#eeecff"/>
<image href="data:image/png;base64,${icon.toString('base64')}" x="64" y="52" width="48" height="48"/>
<g font-family="Arial, Helvetica, sans-serif">
<text x="1150" y="79" text-anchor="end" font-size="20" fill="#575b69">A Graphic Meat creation</text>
<text x="126" y="85" font-size="31" font-weight="700" fill="#20212c">MailVault</text>
<g font-size="72" font-weight="700" letter-spacing="-2" fill="#20212c">
<text x="64" y="208">Make room</text>
<text x="64" y="290">for new mail.</text>
<text x="64" y="372" fill="#4f46df">Keep the old.</text>
</g>
<text x="66" y="436" font-size="25" fill="#575b69">Your email. Saved on your computer.</text>
<text x="66" y="542" font-size="24" font-weight="700" fill="#20212c">Free for macOS &amp; Linux</text>
<text x="66" y="581" font-size="21" fill="#575b69">mailvaultapp.com</text>
</g>
<image href="data:image/png;base64,${app.toString('base64')}" x="648" y="122" width="730" height="471" clip-path="url(#app)"/>
<g transform="translate(0 108) scale(0.833333 0.6)"><path d="M0 22 H240 L254 8 H348 L362 22 H438 L460 0 H580 L602 22 H690 L704 8 H798 L812 22 H886 L908 0 H1028 L1050 22 H1126 L1140 8 H1234 L1248 22 H1440" fill="none" stroke="#4f46df" stroke-width="1.5" vector-effect="non-scaling-stroke"/></g>
</svg>`;
await sharp(Buffer.from(svg)).png().toFile(resolve(root,'website/assets/og-mailvault-en-v2.png'));
console.log('Generated website/assets/og-mailvault-en-v2.png (1200 × 630)');
