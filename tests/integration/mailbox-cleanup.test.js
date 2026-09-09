import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackMailbox } from '../e2e/mockImap.js';
import { createClient, deliver, startSeededServer } from './mockHarness.js';

describe('E2E mailbox cleanup', () => {
  let server;
  beforeEach(async () => { server = await startSeededServer({ inbox: 3 }); });
  afterEach(() => { server?.stop(); });

  async function inboxUids() {
    const client = createClient(server);
    await client.connect();
    try {
      await client.mailboxOpen('INBOX');
      return await client.search({ all: true }, { uid: true });
    } finally {
      await client.logout();
    }
  }

  it('preserves the fixtures when no message was added', async () => {
    const original = await inboxUids();
    const restore = await trackMailbox(server, 'INBOX');
    await restore();
    expect(await inboxUids()).toEqual(original);
  });

  it('removes only added mail and remains safe when cleanup runs again', async () => {
    const original = await inboxUids();
    const restore = await trackMailbox(server, 'INBOX');
    await deliver(server, { subject: 'Temporary notification test' });
    expect((await inboxUids()).length).toBe(original.length + 1);
    await restore();
    expect(await inboxUids()).toEqual(original);
    await restore();
    expect(await inboxUids()).toEqual(original);
  });
});
