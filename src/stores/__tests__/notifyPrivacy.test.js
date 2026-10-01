import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../services/api', () => ({ sendNotification: vi.fn(() => Promise.resolve()) }));
import { sendNotification } from '../../services/api';
import { notify, useFocusStore } from '../focusStore';
import { usePrivacyStore } from '../privacyStore';
import { setPrivacyDictionary } from '../../utils/privacy/privacyDictionary';
import { buildNameDictionary } from '../../utils/privacy/piiDetector';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
  sendNotification.mockClear();
  useFocusStore.setState({ endsAt: null, held: [] });
  setPrivacyDictionary(buildNameDictionary({ names: ['John Smith'] }), { ready: true });
});

describe('notify under privacy mode', () => {
  it('mail banners become generic', async () => {
    usePrivacyStore.setState({ enabled: true });
    await notify('John Smith', 'Lunch at 221B Baker Street?', undefined, undefined, { accountId: 'a', folder: 'INBOX', from: 'j@x.com', domain: 'x.com', viewIds: [] });
    const [title, body] = sendNotification.mock.calls[0];
    expect(title).toBe('New message');
    expect(body).toBe('');
  });
  it('other banners are masked, not dropped', async () => {
    usePrivacyStore.setState({ enabled: true });
    await notify('Backup done', 'Saved mail for John Smith');
    expect(sendNotification.mock.calls[0][1]).toBe('Saved mail for xxxx xxxxx');
  });
  it('a banner held by a focus session is masked too', async () => {
    usePrivacyStore.setState({ enabled: true });
    useFocusStore.setState({ endsAt: Date.now() + 60_000 });
    await notify('Backup done', 'Saved mail for John Smith');
    expect(sendNotification).not.toHaveBeenCalled();
    expect(useFocusStore.getState().held[0].body).toBe('Saved mail for xxxx xxxxx');
  });
  it('masks before the saved choice has loaded, even when it will turn out off', async () => {
    usePrivacyStore.setState({ enabled: false });
    usePrivacyStore.persist.hasHydrated.mockReturnValue(false);
    await notify('Backup done', 'Saved mail for John Smith');
    expect(sendNotification.mock.calls[0][1]).toBe('Saved mail for xxxx xxxxx');
  });
  it('privacy off leaves banners untouched', async () => {
    usePrivacyStore.setState({ enabled: false });
    await notify('Backup done', 'Saved mail for John Smith');
    expect(sendNotification.mock.calls[0][1]).toBe('Saved mail for John Smith');
  });
});
