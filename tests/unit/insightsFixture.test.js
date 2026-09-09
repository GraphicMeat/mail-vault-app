import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { buildInsightsScenario } from '../e2e/insightsFixture';

describe('dedicated Insights native scenario', () => {
  it('has an actual 700-message inbox and distinct cross-account/nested UID 1 locators', () => {
    const fixture = buildInsightsScenario();
    expect(fixture.accounts).toHaveLength(2);
    const [first, second] = fixture.accounts;
    const inbox = first.scenario.state.mailboxes.find(box => box.name === 'INBOX');
    expect(inbox.messages).toHaveLength(700);
    expect(second.scenario.state.mailboxes.find(box => box.name === 'INBOX').messages[0].uid).toBe(1);
    expect(first.scenario.state.mailboxes.find(box => box.name === 'Projects/Archive').messages[0].uid).toBe(1);
    expect(first.id).not.toBe(second.id);
  });
  it('carries true RFC identity, automation and receive-time boundary evidence', async () => {
    const fixture = buildInsightsScenario();
    const messages = fixture.accounts[0].scenario.state.mailboxes[0].messages;
    const old = await simpleParser(messages[0].raw);
    const auto = await simpleParser(messages[110].raw);
    const boundary = await simpleParser(messages[111].raw);
    expect(old.from.value[0].address).toBe('old@insights.test');
    expect(auto.headerLines.some(header => header.key === 'list-id' && header.line.includes('digest.insights.test'))).toBe(true);
    expect(boundary.date.toISOString()).toBe('2026-09-08T19:00:00.000Z');
    expect(messages[111].internal_date).toBe('08-Sep-2026 22:30:00 +0000');
    expect(boundary.messageId).toBe('<insights-boundary@fixture.test>');
  });
  it('provides literal logical counts and excludes Drafts/Trash/Junk fixture mail', async () => {
    const fixture = buildInsightsScenario();
    expect(fixture.expected).toMatchObject({ startDate: '2026-09-01', endDate: '2026-09-30', received: 703, sent: 3, both: 706, receivedWithoutAutomated: 702, physicalIncluded: 706 });
    const boxes = fixture.accounts[0].scenario.state.mailboxes;
    const sent = boxes.find(box => box.name === 'Sent');
    const multipleRecipients = await simpleParser(sent.messages[0].raw);
    expect(multipleRecipients.to.value.map(to => to.address)).toEqual(['ana@insights.test', 'bob@insights.test', 'carol@insights.test']);
    const duplicate = boxes.find(box => box.name === 'Archive').messages[0];
    expect(duplicate.raw).toBe(boxes[0].messages[699].raw);
    expect(boxes.filter(box => ['Drafts', 'Trash', 'Junk'].includes(box.name)).every(box => box.messages.length === 1)).toBe(true);
  });
  it('can construct the large native inventory without changing default fixture accounts', () => {
    const fixture = buildInsightsScenario({ inboxCount: 50000 });
    expect(fixture.accounts[0].scenario.state.mailboxes[0].messages).toHaveLength(50000);
    expect(fixture.expected.received).toBe(50003);
    expect(buildInsightsScenario().accounts[0].scenario.state.mailboxes[0].messages).toHaveLength(700);
  });
});
