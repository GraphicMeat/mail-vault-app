import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';

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
      <Dialog
        open
        onClose={() => this.setState({ failed: false })}
        role="alertdialog"
        // A chunk that failed to load can be the one a dialog was opening, so
        // this has to sit above every other layer.
        z={Z.fatal}
        title={`${this.props.name} could not open`}
        icon={
          <div className="w-10 h-10 rounded-full bg-mail-warning-tint flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={20} className="text-mail-warning" />
          </div>
        }
        description="Part of the app failed to load from disk. This usually means an update replaced the app while it was running. Reloading picks up the new version. Your mail and your vault are untouched."
        footer={
          <>
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => this.setState({ failed: false })}>
              Dismiss
            </Button>
            <Button variant="primary" size="lg" className="flex-1" data-autofocus onClick={() => window.location.reload()}>
              Reload
            </Button>
          </>
        }
      />
    );
  }
}
