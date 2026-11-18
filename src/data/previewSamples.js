// The preview cast's pure parts: no translator, store or formatter imported, so the settings views
// both apps render can use them (data/previewMail.js re-exports them for desktop). Cast, brands and
// addresses stay untranslated; the copy is looked up by the caller's `t`.

/**
 * The same three accounts and the same cast as every marketing screenshot
 * (`scripts/screenshots/demoData.js`), so the app someone configures during
 * onboarding looks like the app they saw on the website.
 */
export const PREVIEW_ACCOUNTS = Object.freeze([
  { id: 'preview-studio',   name: 'Prime Cut Studio', email: 'rowan@primecut.studio' },
  { id: 'preview-personal', name: 'Rowan Marsh',      email: 'rowan.marsh@gmail.com' },
  { id: 'preview-billing',  name: 'Studio Accounts',  email: 'accounts@primecut.studio' },
]);

/** The row the after-delete example opens: previewMail's second row. */
export const AFTER_DELETE_SAMPLE = Object.freeze({ sender: 'MeatPad', subjectKey: 'preview.row2.subject' });

/** Who the sample conversation is with. */
export const CONVERSATION_CONTACT = 'Nell Okafor';

/**
 * One coherent fictional thread, shared by the workspace and feature tour: the caller's translator and
 * `formatTime(date)`.
 */
export function sampleConversation(translate, formatTime) {
  return ['question', 'answer', 'followup'].map((key, index) => ({
    id: `preview-reply-${index}`,
    sender: index === 1 ? 'Rowan' : CONVERSATION_CONTACT,
    sent: index === 1,
    text: translate(`settings.preview.${key}`),
    time: formatTime(new Date(2026, 1, 25, 13, 15 + index * 10)),
  }));
}
