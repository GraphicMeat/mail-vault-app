import React, { useEffect, useState } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { useLearningStore } from '../stores/learningStore';
import * as classificationService from '../services/classificationService';
import * as llmService from '../services/llmService';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Mail, Newspaper, Tag, Bell, Receipt, User, Briefcase, ShieldAlert,
  Trash2, Archive, CheckCircle2, HelpCircle, ChevronLeft, X,
  Loader, AlertCircle, Lock, Sparkles, Download, Clock, Info,
  Settings,
} from 'lucide-react';

const CATEGORY_META = {
  newsletter: { icon: Newspaper, label: 'Newsletters', color: 'text-blue-500', bg: 'bg-blue-500/10' },
  promotional: { icon: Tag, label: 'Promotions', color: 'text-orange-500', bg: 'bg-orange-500/10' },
  notification: { icon: Bell, label: 'Notifications', color: 'text-purple-500', bg: 'bg-purple-500/10' },
  transactional: { icon: Receipt, label: 'Transactional', color: 'text-green-500', bg: 'bg-green-500/10' },
  personal: { icon: User, label: 'Personal', color: 'text-sky-500', bg: 'bg-sky-500/10' },
  work: { icon: Briefcase, label: 'Work', color: 'text-indigo-500', bg: 'bg-indigo-500/10' },
  'spam-likely': { icon: ShieldAlert, label: 'Spam (likely)', color: 'text-red-500', bg: 'bg-red-500/10' },
};

const ACTION_META = {
  keep: { icon: CheckCircle2, label: 'Keep', color: 'text-emerald-600' },
  archive: { icon: Archive, label: 'Archive', color: 'text-blue-600' },
  'delete-from-server': { icon: Trash2, label: 'Delete from server', color: 'text-red-600' },
  review: { icon: HelpCircle, label: 'Needs review', color: 'text-amber-600' },
};

/**
 * Cleanup Report — AI classification summary with bulk actions.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {Function} props.onClose
 * @param {Function} props.onOpenSettings - (tabId) => void, opens Settings at a specific tab
 */
export function CleanupReport({ isOpen, onClose, onOpenSettings }) {
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPremium = hasPremiumAccess(billingProfile);

  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drillCategory, setDrillCategory] = useState(null);
  const [drillEmails, setDrillEmails] = useState([]);
  const [llmStatus, setLlmStatus] = useState(null);
  const [classStatus, setClassStatus] = useState(null);

  useEffect(() => {
    if (!isOpen || !activeAccountId || !isPremium) return;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [s, ls, cs] = await Promise.all([
          classificationService.getSummary(activeAccountId),
          llmService.getStatus().catch(() => null),
          classificationService.getStatus().catch(() => null),
        ]);
        setSummary(s);
        setLlmStatus(ls);
        setClassStatus(cs);
      } catch (e) {
        setError(e.message);
      }
      setLoading(false);
    };
    load();

    const interval = setInterval(async () => {
      try {
        const cs = await classificationService.getStatus();
        setClassStatus(cs);
        if (cs?.status === 'Complete' || cs?.status === 'Idle') {
          const s = await classificationService.getSummary(activeAccountId);
          setSummary(s);
        }
      } catch {}
    }, 3000);

    return () => clearInterval(interval);
  }, [isOpen, activeAccountId, isPremium]);

  const handleDrill = async (category) => {
    try {
      const results = await classificationService.getResults(activeAccountId, category);
      setDrillEmails(results);
      setDrillCategory(category);
    } catch (e) {
      setError(e.message);
    }
  };

  if (!isOpen) return null;

  const hasModel = llmStatus && llmStatus.status !== 'no-model';
  const hasResults = summary && summary.total > 0;
  const isClassifying = classStatus?.status === 'Running';

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-40 flex justify-end"
      >
        <div className="absolute inset-0 bg-black/30" onClick={onClose} />

        <motion.div
          initial={{ x: 400 }}
          animate={{ x: 0 }}
          exit={{ x: 400 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="relative w-[520px] max-w-[90vw] h-full bg-mail-bg border-l border-mail-border shadow-2xl flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border bg-mail-sidebar">
            <div className="flex items-center gap-2">
              {drillCategory && (
                <button onClick={() => setDrillCategory(null)} className="p-1 rounded hover:bg-mail-hover transition-colors">
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}
              <Sparkles className="w-5 h-5 text-mail-accent" />
              <h2 className="font-semibold text-sm">
                {drillCategory ? CATEGORY_META[drillCategory]?.label || drillCategory : 'AI Cleanup'}
              </h2>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-mail-hover transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {!isPremium ? (
              <PremiumGate />
            ) : loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader className="w-5 h-5 animate-spin text-mail-muted" />
              </div>
            ) : error ? (
              <div className="p-4">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              </div>
            ) : drillCategory ? (
              <CategoryDrilldown
                category={drillCategory}
                emails={drillEmails}
              />
            ) : isClassifying ? (
              <ClassifyingState classStatus={classStatus} />
            ) : !hasModel ? (
              <NoModelState onOpenSettings={onOpenSettings} onClose={onClose} />
            ) : !hasResults ? (
              <NoResultsState onOpenSettings={onOpenSettings} onClose={onClose} />
            ) : (
              <SummaryView summary={summary} onDrill={handleDrill} />
            )}
          </div>

          {/* Safety banner */}
          {isPremium && hasResults && (
            <div className="px-4 py-2 border-t border-mail-border bg-emerald-500/5">
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                Local copies are always preserved. You can restore any email from Time Capsule.
              </p>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function PremiumGate() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 text-center">
      <Lock className="w-10 h-10 text-mail-muted mb-4" />
      <h3 className="font-semibold text-lg mb-2">AI Cleanup is a Premium Feature</h3>
      <p className="text-sm text-mail-secondary mb-4">
        Automatically classify your emails and clean up newsletters, promotions, and spam with one click.
      </p>
    </div>
  );
}

function NoModelState({ onOpenSettings, onClose }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 text-center">
      <Download className="w-10 h-10 text-mail-muted mb-4" />
      <h3 className="font-semibold text-base mb-2">Download an AI Model</h3>
      <p className="text-sm text-mail-secondary mb-6 max-w-sm">
        To classify your emails, MailVault needs a local AI model. Download one in Settings — it runs entirely on your machine, no data leaves your device.
      </p>
      <button
        onClick={() => { onClose(); onOpenSettings?.('ai'); }}
        className="px-5 py-2 rounded-lg bg-mail-accent text-white text-sm font-medium hover:bg-mail-accent/90 transition-colors"
      >
        Open AI Settings
      </button>
      <HowItWorks />
    </div>
  );
}

function NoResultsState({ onOpenSettings, onClose }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 text-center">
      <Clock className="w-10 h-10 text-mail-muted mb-4" />
      <h3 className="font-semibold text-base mb-2">No Classifications Yet</h3>
      <p className="text-sm text-mail-secondary mb-6 max-w-sm">
        Classification runs automatically after each backup. Run a backup to get your first cleanup report.
      </p>
      <button
        onClick={() => { onClose(); onOpenSettings?.('backup'); }}
        className="px-5 py-2 rounded-lg bg-mail-accent text-white text-sm font-medium hover:bg-mail-accent/90 transition-colors"
      >
        Open Backup Settings
      </button>
      <HowItWorks />
    </div>
  );
}

function ClassifyingState({ classStatus }) {
  const pct = classStatus.total > 0 ? (classStatus.classified / classStatus.total * 100) : 0;
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 text-center">
      <Loader className="w-10 h-10 text-mail-accent mb-4 animate-spin" />
      <h3 className="font-semibold text-base mb-2">Classifying Emails...</h3>
      <p className="text-sm text-mail-secondary mb-4">
        {classStatus.classified.toLocaleString()} / {classStatus.total.toLocaleString()} emails processed
        {classStatus.skipped_by_rules > 0 && (
          <span className="block text-xs mt-1">({classStatus.skipped_by_rules} matched learned rules)</span>
        )}
      </p>
      <div className="w-full max-w-xs h-2 bg-mail-hover rounded-full overflow-hidden">
        <div className="h-full bg-mail-accent rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function HowItWorks() {
  return (
    <div className="mt-8 p-4 rounded-lg bg-mail-hover/50 text-left max-w-sm w-full">
      <div className="flex items-center gap-2 mb-2">
        <Info className="w-4 h-4 text-mail-accent shrink-0" />
        <span className="text-xs font-semibold text-mail-secondary">How classification works</span>
      </div>
      <ol className="text-[11px] text-mail-muted list-decimal list-inside space-y-1">
        <li>A local AI model runs on your machine — no data leaves your device.</li>
        <li>After each backup, the model classifies your emails into categories.</li>
        <li>Review the cleanup report and approve bulk actions.</li>
        <li>Your corrections become learned rules that improve over time.</li>
      </ol>
    </div>
  );
}

function SummaryView({ summary, onDrill }) {
  const categories = Object.entries(summary.by_category).sort(([, a], [, b]) => b - a);
  const deletable = summary.by_action?.['delete-from-server'] || 0;
  const archivable = summary.by_action?.['archive'] || 0;

  return (
    <div className="p-4 space-y-4">
      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="p-3 rounded-lg bg-mail-hover/50 text-center">
          <p className="text-2xl font-bold">{summary.total.toLocaleString()}</p>
          <p className="text-[11px] text-mail-muted">Classified</p>
        </div>
        <div className="p-3 rounded-lg bg-red-500/5 text-center">
          <p className="text-2xl font-bold text-red-600 dark:text-red-400">{deletable.toLocaleString()}</p>
          <p className="text-[11px] text-mail-muted">Can delete</p>
        </div>
        <div className="p-3 rounded-lg bg-blue-500/5 text-center">
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{archivable.toLocaleString()}</p>
          <p className="text-[11px] text-mail-muted">Can archive</p>
        </div>
      </div>

      {/* Category breakdown */}
      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold text-mail-muted uppercase tracking-wide px-1">By Category</h3>
        {categories.map(([category, count]) => {
          const meta = CATEGORY_META[category] || { icon: Mail, label: category, color: 'text-slate-500', bg: 'bg-slate-500/10' };
          const Icon = meta.icon;
          return (
            <button
              key={category}
              onClick={() => onDrill(category)}
              className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-mail-hover/50 transition-colors text-left group"
            >
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg ${meta.bg} flex items-center justify-center`}>
                  <Icon className={`w-4 h-4 ${meta.color}`} />
                </div>
                <span className="text-sm font-medium">{meta.label}</span>
              </div>
              <span className="text-sm font-semibold text-mail-secondary group-hover:text-mail-primary">
                {count.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CategoryDrilldown({ category, emails }) {
  const meta = CATEGORY_META[category] || { icon: Mail, label: category };

  if (emails.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-mail-muted">No emails in this category</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <p className="text-xs text-mail-secondary">{emails.length} emails classified as {meta.label}</p>
      <div className="space-y-1">
        {emails.map((entry) => {
          const c = entry.classification;
          const actionMeta = ACTION_META[c?.action] || ACTION_META.review;
          const ActionIcon = actionMeta.icon;

          return (
            <div
              key={entry.messageId}
              className="flex items-center justify-between p-2.5 rounded-lg border border-mail-border hover:bg-mail-hover/30 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{entry.messageId}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`text-[11px] ${actionMeta.color} flex items-center gap-1`}>
                    <ActionIcon className="w-3 h-3" />
                    {actionMeta.label}
                  </span>
                  <span className="text-[11px] text-mail-muted">
                    {Math.round((c?.confidence || 0) * 100)}% confidence
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
