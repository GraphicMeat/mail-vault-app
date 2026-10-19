import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('../transport.js', () => ({ send: (...a) => send(...a) }));

const api = await import('../learningApi.js');
const { t } = await import('../../i18n/index.js');

describe('learningApi', () => {
  beforeEach(() => { send.mockReset(); });

  it('sends each call to its learning RPC', async () => {
    send.mockResolvedValue('ok');
    const email = { messageId: '<m@x>', from: 'a@x.com', subject: 'Hi' };
    const correction = { originalCategory: 'personal', correctedCategory: 'work', correctedAction: 'keep' };
    await api.recordCorrection('acc', email, correction);
    expect(send).toHaveBeenLastCalledWith('learning.record_correction', { accountId: 'acc', email, correction });
    await api.getRules('acc');
    expect(send).toHaveBeenLastCalledWith('learning.rules', { accountId: 'acc' });
    await api.getStats('acc');
    expect(send).toHaveBeenLastCalledWith('learning.stats', { accountId: 'acc' });
    await api.saveRule('acc', { id: 'r1' });
    expect(send).toHaveBeenLastCalledWith('learning.save_rule', { accountId: 'acc', rule: { id: 'r1' } });
    await api.deleteRule('acc', 'r1');
    expect(send).toHaveBeenLastCalledWith('learning.delete_rule', { accountId: 'acc', ruleId: 'r1' });
    await api.exportRules('acc');
    expect(send).toHaveBeenLastCalledWith('learning.export', { accountId: 'acc' });
  });

  it('reads as no rules and empty stats when the daemon cannot answer', async () => {
    send.mockRejectedValue(new Error('errors.daemonUnavailable'));
    await expect(api.getRules('acc')).resolves.toEqual([]);
    await expect(api.getStats('acc')).resolves.toEqual({ totalClassified: 0, totalCorrected: 0, accuracyRate: 1, rulesCount: 0, correctionsCount: 0 });
  });

  it('writes fail loudly', async () => {
    send.mockRejectedValue(new Error('boom'));
    await expect(api.recordCorrection('acc', {}, {})).rejects.toThrow('boom');
    await expect(api.saveRule('acc', {})).rejects.toThrow('boom');
    await expect(api.deleteRule('acc', 'r')).rejects.toThrow('boom');
  });

  it('reports a rule the daemon refused to save in the catalog wording', async () => {
    send.mockResolvedValue({ saved: false, errorKey: 'svc.learning.sharedDomainRule', errorParams: { domain: 'gmail.com' } });
    const r = await api.saveRule('acc', { id: 'r1', pattern: { fromDomain: 'gmail.com' } });
    expect(r).toEqual({ saved: false, error: t('svc.learning.sharedDomainRule', { domain: 'gmail.com' }) });
    expect(r.error).toContain('gmail.com');
    expect(r.error).not.toBe('svc.learning.sharedDomainRule');
    send.mockResolvedValue({ saved: true });
    await expect(api.saveRule('acc', { id: 'r2' })).resolves.toEqual({ saved: true, error: null });
  });

  it('says which rules an import left out', async () => {
    send.mockResolvedValue({ valid: true, imported: 1, errorKey: 'svc.learning.sharedDomainRule', errorParams: { domain: 'gmail.com' } });
    const r = await api.importRulesFile('acc', '{"version":1,"rules":[]}');
    expect(r).toEqual({ valid: true, imported: 1, error: t('svc.learning.sharedDomainRule', { domain: 'gmail.com' }) });
  });

  it('imports a parsed file and reports the count', async () => {
    send.mockResolvedValue({ valid: true, imported: 2 });
    const r = await api.importRulesFile('acc', '{"version":1,"rules":[]}');
    expect(send).toHaveBeenCalledWith('learning.import', { accountId: 'acc', data: { version: 1, rules: [] } });
    expect(r).toEqual({ valid: true, imported: 2, error: null });
  });

  it('words a refused file with the catalog key the daemon names', async () => {
    send.mockResolvedValue({ valid: false, errorKey: 'svc.ruleExporter.unsupportedFormatVersionAppSupports', errorParams: { data: 2, EXPORT_VERSION: 1 } });
    const r = await api.importRulesFile('acc', '{"version":2,"rules":[]}');
    expect(r).toEqual({ valid: false, imported: 0, error: t('svc.ruleExporter.unsupportedFormatVersionAppSupports', { data: 2, EXPORT_VERSION: 1 }) });
    expect(r.error).toContain('2');
  });

  it('words text that is not JSON as a parse error without asking the daemon', async () => {
    const r = await api.importRulesFile('acc', '{nope');
    expect(send).not.toHaveBeenCalled();
    expect(r.valid).toBe(false);
    expect(r.error).toBe(t('svc.ruleExporter.parseError', { e: (() => { try { JSON.parse('{nope'); } catch (e) { return e.message; } })() }));
  });
});
