import React, { useEffect, useState } from 'react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { useLearningStore } from '../../stores/learningStore';
import { useAccountStore } from '../../stores/accountStore';
import * as llmService from '../../services/llmService';
import { exportRules, previewImport, importRules } from '../../services/ruleExporter';
import {
  Sparkles, Download, Trash2, HardDrive, Loader, CheckCircle2,
  AlertCircle, XCircle, Upload, FileDown, Lock, Cpu, Zap,
  Info, Brain,
} from 'lucide-react';

export function AISettings() {
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPremium = hasPremiumAccess(billingProfile);
  const activeAccountId = useAccountStore(s => s.activeAccountId);

  const [llmStatus, setLlmStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [error, setError] = useState(null);

  const { rules, stats, loadRules, deleteRule } = useLearningStore();

  const refreshStatus = async () => {
    try {
      const [status, modelList] = await Promise.all([
        llmService.getStatus(),
        llmService.listModels(),
      ]);
      setLlmStatus(status);
      setModels(modelList);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    if (!isPremium) return;
    refreshStatus();
    if (activeAccountId) loadRules(activeAccountId);

    const interval = setInterval(async () => {
      try {
        const status = await llmService.getStatus();
        setLlmStatus(prev => {
          // Refresh model list when download finishes
          if (prev?.status === 'downloading' && status.status !== 'downloading') {
            llmService.listModels().then(setModels).catch(() => {});
          }
          return status;
        });
      } catch {}
    }, 2000);

    return () => clearInterval(interval);
  }, [isPremium, activeAccountId]);

  const handleDownload = async (modelId) => {
    setError(null);
    try { await llmService.downloadModel(modelId); } catch (e) { setError(e.message); }
  };

  const handleCancelDownload = async () => {
    try { await llmService.cancelDownload(); } catch {}
  };

  const handleDeleteModel = async (modelId) => {
    try {
      await llmService.deleteModel(modelId);
      await refreshStatus();
    } catch (e) { setError(e.message); }
  };

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
        const count = await importRules(
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

  const isDownloading = llmStatus?.status === 'downloading';
  const downloadProgress = llmStatus?.download;

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
          <h3 className="text-sm font-semibold text-mail-text">How classification works</h3>
        </div>
        <div className="text-xs text-mail-text-muted space-y-2">
          <p>MailVault runs an AI model entirely on your machine — no email data ever leaves your device.</p>
          <ol className="list-decimal list-inside space-y-1 pl-1">
            <li><strong>Download a model</strong> below (one-time, ~2-5 GB).</li>
            <li><strong>Run a backup</strong> — the backup provides the email content for classification.</li>
            <li><strong>View results</strong> in AI Cleanup — emails are sorted into categories with suggested actions.</li>
            <li><strong>Correct mistakes</strong> — your corrections become learned rules that improve accuracy over time.</li>
          </ol>
        </div>
      </div>

      {/* AI Models */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-mail-accent/10 flex items-center justify-center">
            <Cpu size={20} className="text-mail-accent" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-mail-text">AI Models</h3>
            <p className="text-xs text-mail-text-muted">Download a model to enable email classification.</p>
          </div>
        </div>

        {/* Download progress */}
        {isDownloading && downloadProgress && (
          <div className="mb-4 p-3 rounded-lg bg-mail-accent/5 border border-mail-accent/20">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-mail-text">Downloading {downloadProgress.model_id}...</span>
              <button onClick={handleCancelDownload} className="text-xs text-red-500 hover:text-red-600">Cancel</button>
            </div>
            <div className="h-2 bg-mail-surface-hover rounded-full overflow-hidden">
              <div
                className="h-full bg-mail-accent rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress.total_bytes > 0 ? (downloadProgress.downloaded_bytes / downloadProgress.total_bytes * 100) : 0}%` }}
              />
            </div>
            <p className="text-[11px] text-mail-text-muted mt-1">
              {formatBytes(downloadProgress.downloaded_bytes)} / {formatBytes(downloadProgress.total_bytes)}
            </p>
          </div>
        )}

        <div className="space-y-2">
          {models.map(model => (
            <div key={model.id} className="flex items-center justify-between p-3 rounded-lg border border-mail-border">
              <div className="flex items-center gap-3">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${model.downloaded ? 'bg-emerald-500/10' : 'bg-mail-surface-hover'}`}>
                  {model.downloaded
                    ? <CheckCircle2 size={16} className="text-emerald-500" />
                    : <Download size={16} className="text-mail-text-muted" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-mail-text">
                    {model.name}
                    {model.recommended && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-mail-accent/10 text-mail-accent">Recommended</span>
                    )}
                  </p>
                  <p className="text-[11px] text-mail-text-muted">{formatBytes(model.size_bytes)}</p>
                </div>
              </div>

              {model.downloaded ? (
                <button
                  onClick={() => handleDeleteModel(model.id)}
                  className="p-1.5 rounded hover:bg-red-500/10 text-mail-text-muted hover:text-red-500 transition-colors"
                  title="Delete model"
                >
                  <Trash2 size={14} />
                </button>
              ) : (
                <button
                  onClick={() => handleDownload(model.id)}
                  disabled={isDownloading}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-mail-accent text-white hover:bg-mail-accent/90 disabled:opacity-50 transition-colors"
                >
                  Download
                </button>
              )}
            </div>
          ))}
        </div>

        {llmStatus && (
          <p className="text-[11px] text-mail-text-muted mt-3 flex items-center gap-1">
            <HardDrive size={12} />
            Models stored in: {llmStatus.models_dir}
          </p>
        )}
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
            No rules yet. Rules are auto-generated as you correct AI classifications in the cleanup report.
          </p>
        ) : (
          <div className="space-y-1">
            {rules.map(rule => (
              <div key={rule.id} className="flex items-center justify-between p-2.5 rounded-lg border border-mail-border text-xs">
                <div>
                  <span className="font-medium text-mail-text">{rule.pattern?.fromDomain || rule.pattern?.subjectContains || '?'}</span>
                  <span className="text-mail-text-muted ml-1.5">&rarr; {rule.category || rule.action}</span>
                  {rule.source === 'imported' && (
                    <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-mail-surface-hover text-mail-text-muted">imported</span>
                  )}
                </div>
                <button
                  onClick={() => deleteRule(activeAccountId, rule.id)}
                  className="p-1 rounded hover:bg-red-500/10 text-mail-text-muted hover:text-red-500 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
