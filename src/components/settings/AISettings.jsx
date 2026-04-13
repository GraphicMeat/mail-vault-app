import React, { useEffect, useState } from 'react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { useLearningStore } from '../../stores/learningStore';
import { useAccountStore } from '../../stores/accountStore';
import { exportRules, previewImport, importRules } from '../../services/ruleExporter';
import * as classificationService from '../../services/classificationService';
import {
  Sparkles, Trash2, AlertCircle, XCircle, Upload, FileDown, Lock,
  Info, Brain, ChevronDown, ChevronRight, Save, Plus,
} from 'lucide-react';

export function AISettings() {
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPremium = hasPremiumAccess(billingProfile);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const customCategories = useSettingsStore(s => s.customCategories);
  const addCustomCategory = useSettingsStore(s => s.addCustomCategory);
  const removeCustomCategory = useSettingsStore(s => s.removeCustomCategory);

  const [error, setError] = useState(null);
  const [editingRuleId, setEditingRuleId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [newCategoryRule, setNewCategoryRule] = useState(false);
  const [newRuleForm, setNewRuleForm] = useState({ domain: '', address: '', subject: '' });
  const { rules, stats, loadRules, deleteRule, saveRule } = useLearningStore();

  useEffect(() => {
    if (!isPremium || !activeAccountId) return;
    loadRules(activeAccountId);
  }, [isPremium, activeAccountId]);

  const handleExportRules = async () => {
    if (!activeAccountId) return;
    try {
      const payload = await exportRules(activeAccountId);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mailvault-rules-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
  };

  const handleImportRules = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const preview = previewImport(text);
      if (!preview.valid) { setError(preview.error); return; }
      try {
        await importRules(
          activeAccountId,
          preview.rules,
          async (aid) => {
            const { daemonCall } = await import('../../services/daemonClient');
            return daemonCall('learning.load', { accountId: aid });
          },
          async (aid, feedback) => {
            const { daemonCall } = await import('../../services/daemonClient');
            return daemonCall('learning.save', { accountId: aid, feedback });
          },
        );
        if (activeAccountId) loadRules(activeAccountId);
        setError(null);
      } catch (e) { setError(e.message); }
    };
    input.click();
  };

  if (!isPremium) {
    return (
      <div className="p-6">
        <div className="bg-mail-surface border border-mail-border rounded-xl p-8 text-center">
          <Lock size={32} className="text-mail-text-muted mx-auto mb-4" />
          <h3 className="text-sm font-semibold text-mail-text mb-2">AI Features Require Premium</h3>
          <p className="text-xs text-mail-text-muted max-w-md mx-auto">
            Local AI-powered email classification, cleanup suggestions, and learned rules are available with a Premium subscription.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-500 flex items-center gap-2">
          <AlertCircle size={14} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><XCircle size={14} /></button>
        </div>
      )}

      {/* How It Works */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-mail-accent/10 flex items-center justify-center">
            <Info size={20} className="text-mail-accent" />
          </div>
          <h3 className="text-sm font-semibold text-mail-text">How Email Cleanup works</h3>
        </div>
        <p className="text-xs text-mail-text-muted mb-3">
          Email Cleanup uses a local AI classifier to sort your emails into categories like newsletters, promotions, notifications, transactional, work, and personal — then suggests whether to keep, archive, or delete each one.
        </p>
        <ol className="text-sm text-mail-text-muted list-decimal list-inside space-y-1.5">
          <li>MailVault analyzes sender domains, subject keywords, email headers, and metadata — all locally on your device.</li>
          <li>Each email gets a category, a suggested action, and a confidence score so you can see how certain the classifier is.</li>
          <li>When you correct a classification, MailVault learns from it — generating rules for that sender or pattern and retraining its model to get smarter over time.</li>
          <li>You can review and manage your learned rules below, and export them to share across accounts.</li>
        </ol>
      </div>

      {/* Learned Rules */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-mail-accent/10 flex items-center justify-center">
              <Brain size={20} className="text-mail-accent" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-mail-text">Learned Rules</h3>
              <p className="text-xs text-mail-text-muted">Auto-generated from your corrections.</p>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleExportRules}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg border border-mail-border hover:bg-mail-surface-hover transition-colors"
            >
              <FileDown size={12} /> Export
            </button>
            <button
              onClick={handleImportRules}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg border border-mail-border hover:bg-mail-surface-hover transition-colors"
            >
              <Upload size={12} /> Import
            </button>
          </div>
        </div>

        {stats && (
          <div className="grid grid-cols-3 gap-2 mb-4">
            <div className="p-2.5 rounded-lg bg-mail-surface-hover text-center">
              <p className="text-lg font-bold text-mail-text">{stats.rulesCount}</p>
              <p className="text-[10px] text-mail-text-muted">Rules</p>
            </div>
            <div className="p-2.5 rounded-lg bg-mail-surface-hover text-center">
              <p className="text-lg font-bold text-mail-text">{stats.correctionsCount || 0}</p>
              <p className="text-[10px] text-mail-text-muted">Corrections</p>
            </div>
            <div className="p-2.5 rounded-lg bg-mail-surface-hover text-center">
              <p className="text-lg font-bold text-mail-text">{stats.accuracyRate ? `${Math.round(stats.accuracyRate * 100)}%` : '--'}</p>
              <p className="text-[10px] text-mail-text-muted">Accuracy</p>
            </div>
          </div>
        )}

        {rules.length === 0 ? (
          <p className="text-xs text-mail-text-muted text-center py-4">
            No rules yet. Rules are auto-generated as you correct classifications in the Email Cleanup tab.
          </p>
        ) : (
          <div className="space-y-1">
            {rules.map(rule => (
              <div key={rule.id} className="rounded-lg border border-mail-border text-xs">
                <div
                  className="flex items-center justify-between p-2.5 cursor-pointer hover:bg-mail-surface-hover transition-colors"
                  onClick={() => {
                    if (editingRuleId === rule.id) {
                      setEditingRuleId(null);
                    } else {
                      setEditingRuleId(rule.id);
                      setEditForm({
                        fromDomain: rule.pattern?.fromDomain || '',
                        fromAddress: rule.pattern?.fromAddress || '',
                        subjectContains: rule.pattern?.subjectContains || '',
                        bodyContains: rule.pattern?.bodyContains || '',
                        category: rule.category || '',
                        action: rule.action || '',
                      });
                    }
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    {editingRuleId === rule.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span className="font-medium text-mail-text">{rule.pattern?.fromDomain || rule.pattern?.fromAddress || rule.pattern?.subjectContains || '?'}</span>
                    <span className="text-mail-text-muted">&rarr; {rule.category || rule.action}</span>
                    {rule.source === 'imported' && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-mail-surface-hover text-mail-text-muted">imported</span>
                    )}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteRule(activeAccountId, rule.id); }}
                    className="p-1 rounded hover:bg-red-500/10 text-mail-text-muted hover:text-red-500 transition-colors"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                {editingRuleId === rule.id && (
                  <div className="px-3 pb-3 pt-1 border-t border-mail-border space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-mail-text-muted">Domain</span>
                        <input value={editForm.fromDomain} onChange={e => setEditForm(f => ({ ...f, fromDomain: e.target.value }))}
                          className="w-full px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text" placeholder="example.com" />
                      </label>
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-mail-text-muted">Address</span>
                        <input value={editForm.fromAddress} onChange={e => setEditForm(f => ({ ...f, fromAddress: e.target.value }))}
                          className="w-full px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text" placeholder="user@example.com" />
                      </label>
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-mail-text-muted">Subject contains</span>
                        <input value={editForm.subjectContains} onChange={e => setEditForm(f => ({ ...f, subjectContains: e.target.value }))}
                          className="w-full px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text" placeholder="keyword" />
                      </label>
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-mail-text-muted">Body contains</span>
                        <input value={editForm.bodyContains} onChange={e => setEditForm(f => ({ ...f, bodyContains: e.target.value }))}
                          className="w-full px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text" placeholder="keyword" />
                      </label>
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-mail-text-muted">Category</span>
                        <input value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}
                          className="w-full px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text" />
                      </label>
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-mail-text-muted">Action</span>
                        <select value={editForm.action} onChange={e => setEditForm(f => ({ ...f, action: e.target.value }))}
                          className="w-full px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text">
                          <option value="keep">Keep</option>
                          <option value="archive">Archive</option>
                          <option value="delete-from-server">Delete</option>
                          <option value="review">Review</option>
                        </select>
                      </label>
                    </div>
                    <button
                      onClick={async () => {
                        const updated = {
                          ...rule,
                          pattern: {
                            fromDomain: editForm.fromDomain || undefined,
                            fromAddress: editForm.fromAddress || undefined,
                            subjectContains: editForm.subjectContains || undefined,
                            bodyContains: editForm.bodyContains || undefined,
                          },
                          category: editForm.category || rule.category,
                          action: editForm.action || rule.action,
                        };
                        await saveRule(activeAccountId, updated);
                        setEditingRuleId(null);
                      }}
                      className="flex items-center gap-1 px-3 py-1 text-[11px] rounded-lg bg-mail-accent text-white hover:bg-mail-accent/90 transition-colors"
                    >
                      <Save size={10} /> Save
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Custom Categories */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-mail-accent/10 flex items-center justify-center">
            <Sparkles size={20} className="text-mail-accent" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-mail-text">Custom Categories</h3>
            <p className="text-xs text-mail-text-muted">Add your own categories for classification.</p>
          </div>
        </div>

        <div className="space-y-2 mb-4">
          {customCategories.length === 0 ? (
            <p className="text-xs text-mail-text-muted italic">No custom categories yet.</p>
          ) : (
            customCategories.map(cat => (
              <div key={cat} className="flex items-center justify-between p-2 rounded-lg border border-mail-border">
                <span className="text-sm text-mail-text">{cat}</span>
                <button
                  onClick={() => removeCustomCategory(cat)}
                  className="p-1 rounded hover:bg-red-500/10 text-mail-text-muted hover:text-red-500 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>

        <form onSubmit={async (e) => {
          e.preventDefault();
          const input = e.target.elements.categoryName;
          const name = input.value.trim();
          if (!name) return;
          addCustomCategory(name);

          // If rule fields were filled, create the rule + reclassify
          const { domain, address, subject } = newRuleForm;
          if (domain || address || subject) {
            const rule = {
              id: `r-${Date.now()}`,
              type: 'sender-action',
              pattern: {
                fromDomain: domain || undefined,
                fromAddress: address || undefined,
                subjectContains: subject || undefined,
              },
              category: name.toLowerCase(),
              action: 'review',
              confidence: 0.95,
              source: 'manual',
              createdAt: new Date().toISOString(),
            };
            await saveRule(activeAccountId, rule);
            classificationService.reclassifyAll(activeAccountId).catch(() => {});
          }

          input.value = '';
          setNewCategoryRule(false);
          setNewRuleForm({ domain: '', address: '', subject: '' });
        }} className="space-y-2">
          <div className="flex gap-2">
            <input
              name="categoryName"
              type="text"
              placeholder="New category name..."
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-mail-border bg-mail-bg text-mail-text placeholder-mail-text-muted focus:outline-none focus:border-mail-accent"
            />
            <button
              type="button"
              onClick={() => setNewCategoryRule(!newCategoryRule)}
              className={`px-2 py-2 text-sm rounded-lg border transition-colors ${
                newCategoryRule ? 'border-mail-accent text-mail-accent' : 'border-mail-border text-mail-text-muted hover:border-mail-accent'
              }`}
              title="Add rule for this category"
            >
              <Plus size={14} />
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm rounded-lg bg-mail-accent text-white hover:bg-mail-accent/90 transition-colors"
            >
              Add
            </button>
          </div>
          {newCategoryRule && (
            <div className="grid grid-cols-3 gap-2 p-3 rounded-lg bg-mail-surface-hover border border-mail-border">
              <label className="space-y-0.5">
                <span className="text-[10px] text-mail-text-muted">Sender domain</span>
                <input value={newRuleForm.domain} onChange={e => setNewRuleForm(f => ({ ...f, domain: e.target.value }))}
                  className="w-full px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text" placeholder="booking.com" />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-mail-text-muted">Sender address</span>
                <input value={newRuleForm.address} onChange={e => setNewRuleForm(f => ({ ...f, address: e.target.value }))}
                  className="w-full px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text" placeholder="noreply@..." />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-mail-text-muted">Subject contains</span>
                <input value={newRuleForm.subject} onChange={e => setNewRuleForm(f => ({ ...f, subject: e.target.value }))}
                  className="w-full px-2 py-1 text-xs rounded border border-mail-border bg-mail-bg text-mail-text" placeholder="keyword" />
              </label>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
