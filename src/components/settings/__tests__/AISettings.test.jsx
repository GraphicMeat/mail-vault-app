// @vitest-environment jsdom
// Settings > Cleanup's learned rules panel: rules, stats, export and import
// all come from the daemon's learning.* RPCs.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/classificationService', () => ({ reclassifyAll: vi.fn(() => Promise.resolve()) }));
const mockSend = vi.hoisted(() => vi.fn());
vi.mock('../../../services/transport', () => ({ send: (...a) => Promise.resolve(mockSend(...a)) }));

import { AISettings } from '../AISettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useLearningStore } from '../../../stores/learningStore';
import { t } from '../../../i18n/index.js';

const ACCOUNT = { id: 'ai-account', email: 'ai@example.test' };
const RULE = { id: 'r1', type: 'sender-action', pattern: { fromDomain: 'shop.example' }, category: 'promotional', action: 'archive', confidence: 0.95, source: 'learned' };
const FILE_TEXT = '{\n  "version": 1\n}';

function answer(command) {
  switch (command) {
    case 'learning.rules': return [RULE];
    case 'learning.stats': return { total_classified: 0, total_corrected: 0, accuracy_rate: 0, rulesCount: 1, correctionsCount: 3 };
    case 'learning.export': return { payload: { version: 1 }, json: FILE_TEXT };
    case 'learning.import': return { valid: false, errorKey: 'svc.ruleExporter.unsupportedFormatVersionAppSupports', errorParams: { data: 2, EXPORT_VERSION: 1 } };
    default: return undefined;
  }
}

let mailState;
let settingsState;
beforeEach(() => {
  vi.clearAllMocks();
  mailState = useMailStore.getState();
  settingsState = useSettingsStore.getState();
  useMailStore.setState({ accounts: [ACCOUNT], activeAccountId: ACCOUNT.id, activeMailbox: 'INBOX' });
  useSettingsStore.setState({ customCategories: [], billingProfile: { premiumAccess: true, clientAccessGranted: true, hasSubscription: true, status: 'active' } });
  useLearningStore.getState().reset();
  mockSend.mockImplementation(answer);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useMailStore.setState(mailState, true);
  useSettingsStore.setState(settingsState, true);
});

describe('AISettings learned rules', () => {
  it('shows the rules and counts the daemon answers', async () => {
    render(<AISettings />);
    await screen.findByText('shop.example');
    expect(mockSend).toHaveBeenCalledWith('learning.rules', { accountId: ACCOUNT.id });
    expect(mockSend).toHaveBeenCalledWith('learning.stats', { accountId: ACCOUNT.id });
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('downloads the file text the daemon exported', async () => {
    const createObjectURL = vi.fn(() => 'blob:rules');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<AISettings />);
    await screen.findByText('shop.example');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('common.export')) }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith('learning.export', { accountId: ACCOUNT.id });
    const blob = createObjectURL.mock.calls[0][0];
    expect(await blob.text()).toBe(FILE_TEXT);
  });

  it('sends a picked file to learning.import and shows a refusal in the catalog wording', async () => {
    const realCreate = document.createElement.bind(document);
    let picker = null;
    vi.spyOn(document, 'createElement').mockImplementation((tag, opts) => {
      const el = realCreate(tag, opts);
      if (tag === 'input') { picker = el; el.click = () => {}; }
      return el;
    });
    render(<AISettings />);
    await screen.findByText('shop.example');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('settings.ai.import')) }));
    expect(picker?.type).toBe('file');
    await act(async () => {
      await picker.onchange({ target: { files: [{ text: async () => '{"version":2,"rules":[]}' }] } });
    });
    expect(mockSend).toHaveBeenCalledWith('learning.import', { accountId: ACCOUNT.id, data: { version: 2, rules: [] } });
    expect(await screen.findByText(t('svc.ruleExporter.unsupportedFormatVersionAppSupports', { data: 2, EXPORT_VERSION: 1 }))).toBeTruthy();
  });
});
