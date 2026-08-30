import { t } from '../i18n/index.js';

/**
 * The same three accounts and the same cast as every marketing screenshot
 * (`scripts/screenshots/demoData.js`), so the app someone configures during
 * onboarding looks like the app they saw on the website.
 *
 * Cast, brands, addresses and filenames stay untranslated — that rule is
 * inherited from the screenshot work. Only the copy moves through the catalog.
 * These rows never reach `mailStore`; they exist to be drawn.
 */
export const PREVIEW_ACCOUNTS = Object.freeze([
  { id: 'preview-studio',   name: 'Prime Cut Studio', email: 'rowan@primecut.studio' },
  { id: 'preview-personal', name: 'Rowan Marsh',      email: 'rowan.marsh@gmail.com' },
  { id: 'preview-billing',  name: 'Studio Accounts',  email: 'accounts@primecut.studio' },
]);

// Row senders are fictional contacts/companies from the same cast as the
// marketing screenshots (`scripts/screenshots/demoData.js` CAST) — never one
// of the three PREVIEW_ACCOUNTS names. The sidebar (account names) and this
// list render at the same time in three-column layout, and reusing an account
// name as a sender makes the same string appear twice in the tree, which is
// both confusing to read (an inbox does not receive mail from itself) and
// breaks `getByText` in the appearance-preview test, which relies on each
// account name being unique in the rendered output.
export function previewRows() {
  return [
    { id: 'p1', sender: 'Rack & Rind',      subject: t('preview.row1.subject'), snippet: t('preview.row1.snippet'), time: '09:12', unread: true },
    { id: 'p2', sender: 'MeatPad',          subject: t('preview.row2.subject'), snippet: t('preview.row2.snippet'), time: '08:40', unread: true },
    { id: 'p3', sender: 'Nell Okafor',      subject: t('preview.row3.subject'), snippet: t('preview.row3.snippet'), time: 'Mon',   unread: false },
    { id: 'p4', sender: 'Priya Raines',     subject: t('preview.row4.subject'), snippet: t('preview.row4.snippet'), time: 'Mon',   unread: false },
    { id: 'p5', sender: "Butcher's Ledger", subject: t('preview.row5.subject'), snippet: t('preview.row5.snippet'), time: 'Sun',   unread: false },
    { id: 'p6', sender: 'MeatPad',          subject: t('preview.row6.subject'), snippet: t('preview.row6.snippet'), time: 'Sun',   unread: false },
  ];
}
