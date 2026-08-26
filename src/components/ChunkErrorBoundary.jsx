import React from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Catches a failed lazy-chunk load for one overlay.
 *
 * Compose, Settings and the modals are code-split, so opening one is a file
 * read that can fail — most plausibly when an update has replaced the app's
 * assets underneath a session that is still running, which leaves the old
 * chunk names pointing at files that no longer exist. Without a boundary here
 * that rejection reaches the root ErrorBoundary and takes the whole window
 * down to "Something went wrong. Please restart the app." for what is a
 * recoverable, single-surface failure.
 *
 * `React.lazy` caches the rejected promise, so there is no in-place retry to
 * offer: a reload is the recovery, and it is the honest thing to say.
 */
export class ChunkErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error(`[ChunkErrorBoundary] ${this.props.name} failed to load:`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="chunk-error-title"
        className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      >
        <div className="absolute inset-0 bg-black/50" />
        <div className="relative max-w-md w-full bg-mail-bg border border-mail-border rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-mail-warning/10 flex items-center justify-center flex-shrink-0">
              <AlertTriangle size={20} className="text-mail-warning" />
            </div>
            <h3 id="chunk-error-title" className="text-lg font-semibold text-mail-text">
              {this.props.name} could not open
            </h3>
          </div>
          <p className="text-sm text-mail-text-muted mb-6">
            Part of the app failed to load from disk. This usually means an update
            replaced the app while it was running. Reloading picks up the new
            version. Your mail and your vault are untouched.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => this.setState({ failed: false })}
              className="flex-1 px-4 py-2.5 rounded-lg bg-mail-surface border border-mail-border
                         text-mail-text font-medium hover:bg-mail-surface-hover transition-colors"
            >
              Dismiss
            </button>
            <button
              onClick={() => window.location.reload()}
              className="flex-1 px-4 py-2.5 rounded-lg bg-mail-accent-fill hover:bg-mail-accent-hover
                         text-white font-medium transition-colors"
              autoFocus
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
