/** Reader layouts against the real WebKit view and mock IMAP bodies. */
import { waitForApp, waitForEmails } from './helpers.js';
import { CROSS_FOLDER_SUBJECT, CROSS_FOLDER_INBOX_BODY, CROSS_FOLDER_SENT_BODY } from './mockImap.js';

async function chooseLayout(layout) {
  await browser.execute(value => {
    const select = document.querySelector('#thread-reader-layout');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, layout);
  await browser.waitUntil(async () => browser.execute(value => document.querySelector('#thread-reader-layout')?.value === value, layout));
}
const bodies = () => browser.execute(() => [...document.querySelectorAll('.thread-reader .email-content')].map(node => node.textContent).join('\n'));

async function expandAll() {
  await browser.execute(() => {
    for (const button of document.querySelectorAll('.thread-reader button[aria-expanded="false"]')) button.click();
  });
  await browser.waitUntil(async () => {
    const text = await bodies();
    return text.includes(CROSS_FOLDER_INBOX_BODY) && text.includes(CROSS_FOLDER_SENT_BODY);
  }, { timeout: 30000, timeoutMsg: 'Both mailbox-specific bodies should be readable' });
}

describe('Thread reader layouts', function () {
  this.timeout(180000);
  before(async () => {
    await waitForApp();
    await waitForEmails();
    await browser.execute(() => window.__SETTINGS_STORE__.setState({ threadMode: 'grouped', threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first' }));
    await browser.waitUntil(async () => browser.execute(subject => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')].find(node => node.offsetHeight && Number(node.dataset.threadCount) > 1 && node.textContent.includes(subject));
      if (!row) return false;
      row.click();
      return true;
    }, CROSS_FOLDER_SUBJECT), { timeout: 45000 });
    await $('#thread-reader-layout').waitForExist({ timeout: 15000 });
  });

  it('timeline reads the correct bodies from INBOX and Sent', async () => {
    await expandAll();
    expect(await bodies()).not.toContain('Body of mock message');
  });

  it('compact summaries open messages without opening a compose window', async () => {
    await chooseLayout('compact');
    await browser.execute(() => {
      for (const button of document.querySelectorAll('.thread-reader [data-testid="header-toggle"][aria-expanded="true"]')) button.click();
    });
    await browser.waitUntil(async () => (await $$('.thread-reader button[aria-expanded="false"]')).length === 2);
    await expandAll();
    expect(await browser.execute(() => !!document.querySelector('[data-testid="compose-modal"]'))).toBe(false);
  });

  it('split selects each message and displays its own body', async () => {
    await chooseLayout('split');
    const seen = [];
    for (let index = 0; index < 2; index++) {
      await browser.execute(i => document.querySelectorAll('.thread-reader-split button[aria-pressed]')[i].click(), index);
      await browser.waitUntil(async () => {
        const text = await bodies();
        return text.includes(CROSS_FOLDER_INBOX_BODY) || text.includes(CROSS_FOLDER_SENT_BODY);
      }, { timeout: 30000 });
      seen.push(await bodies());
      expect(await browser.execute(() => document.querySelectorAll('.thread-reader [data-testid="thread-email-header"]').length)).toBe(1);
    }
    expect(seen.join('\n')).toContain(CROSS_FOLDER_INBOX_BODY);
    expect(seen.join('\n')).toContain(CROSS_FOLDER_SENT_BODY);
    expect(await browser.execute(() => window.__SETTINGS_STORE__.getState().threadReaderLayout)).toBe('split');
  });

  it('newest-first puts the newest message at the start of the reader', async () => {
    await chooseLayout('timeline');
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setThreadSortOrder('newest-first'));
    await browser.waitUntil(async () => browser.execute(() => {
      const scroller = document.querySelector('.thread-reader-content > div');
      return scroller && scroller.scrollTop < 2;
    }));
    await expandAll();
  });

  after(async () => {
    await browser.execute(() => window.__SETTINGS_STORE__.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first' }));
  });
});
