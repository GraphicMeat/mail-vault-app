import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, Clock, SkipForward, AlertCircle, RefreshCw } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { version as currentVersion } from '../../package.json';

/**
 * Render changelog markdown with basic formatting:
 * ### headings, ## headings, - bullets with **bold**, plain text
 */
function renderChangelogMarkdown(text) {
  if (!text) return null;

  const lines = text.split('\n');
  const elements = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('### ')) {
      elements.push(
        <h3 key={i} className="text-sm font-semibold text-mail-text mt-3 mb-1">
          {line.slice(4)}
        </h3>
      );
    } else if (line.startsWith('## ')) {
      elements.push(
        <h2 key={i} className="text-base font-semibold text-mail-text mt-4 mb-1.5">
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith('- ')) {
      const content = line.slice(2);
      elements.push(
        <li key={i} className="text-sm text-mail-text-muted ml-4 list-disc">
          {renderInlineMarkdown(content)}
        </li>
      );
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-1" />);
    } else {
      elements.push(
        <p key={i} className="text-sm text-mail-text-muted">
          {renderInlineMarkdown(line)}
        </p>
      );
    }
  }

  return elements;
}

/** Render **bold** spans within text */
function renderInlineMarkdown(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold text-mail-text">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export function UpdateModal({ updateInfo, onClose }) {
  const [state, setState] = useState('idle'); // 'idle' | 'downloading' | 'installing' | 'error'
  const [errorMsg, setErrorMsg] = useState('');
  const [downloadPercent, setDownloadPercent] = useState(0);

  const setUpdateSnooze = useSettingsStore(s => s.setUpdateSnooze);
  const setSkippedVersion = useSettingsStore(s => s.setSkippedVersion);

  const newVersion = updateInfo?.version || 'unknown';
  const notes = updateInfo?.notes || '';

  // Listen for download progress events from Rust
  useEffect(() => {
    if (state !== 'downloading') return;
    let unlisten;
    let active = true;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('update-download-progress', (event) => {
        const { percent } = event.payload;
        setDownloadPercent(percent);
        if (percent >= 100) {
          setState('installing');
        }
      }).then(fn => {
        if (!active) fn();
        else unlisten = fn;
      });
    }).catch(() => {});
    return () => { active = false; if (unlisten) unlisten(); };
  }, [state]);

  const handleSkip = () => {
    setSkippedVersion(newVersion);
    onClose();
  };

  const handleRemindLater = () => {
    setUpdateSnooze();
    onClose();
  };

  const handleUpdateNow = async () => {
    setState('downloading');
    setDownloadPercent(0);
    try {
      await window.__TAURI__?.core?.invoke('install_pending_update');
      // App auto-restarts on success — this line may not execute
    } catch (err) {
      setState('error');
      setErrorMsg(typeof err === 'string' ? err : err?.message || 'Update failed');
    }
  };

  const handleBackdropClick = () => {
    if (state === 'idle') {
      onClose();
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/50"
          onClick={handleBackdropClick}
        />

        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="relative bg-mail-bg border border-mail-border rounded-xl shadow-2xl
                     w-full max-w-lg mx-4 overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-mail-border">
            <div>
              <h2 className="text-lg font-semibold text-mail-text flex items-center gap-2">
                <Download size={20} className="text-mail-accent" />
                MailVault v{newVersion} Available
              </h2>
              <p className="text-xs text-mail-text-muted mt-0.5">
                You're on v{currentVersion}
              </p>
            </div>
            {state === 'idle' && (
              <button onClick={onClose} className="p-1 hover:bg-mail-border rounded transition-colors">
                <X size={18} className="text-mail-text-muted" />
              </button>
            )}
          </div>

          {/* Body */}
          {state === 'idle' && (
            <>
              {notes && (
                <div className="px-5 py-4 max-h-80 overflow-y-auto border-b border-mail-border">
                  {renderChangelogMarkdown(notes)}
                </div>
              )}

              {/* Footer */}
              <div className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSkip}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-mail-text-muted
                               hover:text-mail-text hover:bg-mail-surface rounded-lg transition-colors"
                  >
                    <SkipForward size={14} />
                    Skip Version
                  </button>
                  <button
                    onClick={handleRemindLater}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-mail-text-muted
                               bg-mail-surface hover:bg-mail-border rounded-lg transition-colors"
                  >
                    <Clock size={14} />
                    Remind Later
                  </button>
                </div>
                <button
                  onClick={handleUpdateNow}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white
                             bg-mail-accent hover:bg-mail-accent-hover rounded-lg transition-colors"
                >
                  <Download size={14} />
                  Update Now
                </button>
              </div>
            </>
          )}

          {/* Downloading state */}
          {state === 'downloading' && (
            <div className="px-5 py-8 flex flex-col items-center gap-3">
              <Download size={24} className="text-mail-accent" />
              <p className="text-sm text-mail-text">Downloading v{newVersion}...</p>
              <div className="w-full max-w-xs">
                <div className="h-2 bg-mail-border rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${downloadPercent}%` }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                    className="h-full bg-mail-accent rounded-full"
                  />
                </div>
                <p className="text-xs text-mail-text-muted text-center mt-1.5">{downloadPercent}%</p>
              </div>
            </div>
          )}

          {/* Installing state */}
          {state === 'installing' && (
            <div className="px-5 py-8 flex flex-col items-center gap-3">
              <RefreshCw size={24} className="text-mail-accent animate-spin" />
              <p className="text-sm text-mail-text">Installing update...</p>
              <p className="text-xs text-mail-text-muted">The app will restart automatically</p>
            </div>
          )}

          {/* Error state */}
          {state === 'error' && (
            <div className="px-5 py-5">
              <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-lg mb-4">
                <AlertCircle size={20} className="text-mail-danger flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-mail-text">Failed to install update</p>
                  <p className="text-xs text-mail-text-muted mt-1">
                    {errorMsg.includes('os error 30') || errorMsg.includes('Read-only')
                      ? 'The app cannot update itself due to file system restrictions. Please download the new version manually.'
                      : errorMsg}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <a
                  href={`https://github.com/GraphicMeat/mail-vault-app/releases/tag/v${newVersion}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white
                             bg-mail-accent hover:bg-mail-accent-hover rounded-lg transition-colors"
                >
                  <Download size={14} />
                  Download v{newVersion}
                </a>
                <button
                  onClick={onClose}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium
                             bg-mail-surface hover:bg-mail-border text-mail-text rounded-lg transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
