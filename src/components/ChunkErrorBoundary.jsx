import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';
// A class component cannot call a hook. `t` is module state, not React
// state, so it works here — the error boundary just will not re-render on a
// locale change, which is fine for a terminal surface whose action is reload.
import { t } from '../i18n/index.js';

// A chunk that could not load, as WebKit, WebView2 and Vite's stylesheet preload word it.
const LOAD_FAILURE = /Importing a module script failed|Failed to fetch dynamically imported module|Unable to preload CSS/;

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
 *
 * Anything else the overlay throws lands here too, and blaming an update for
 * that is not honest, so the message depends on which of the two it was.
 */
export class ChunkErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, loadFailure: false };
  }

  static getDerivedStateFromError(error) {
    return { failed: true, loadFailure: LOAD_FAILURE.test(String(error?.message ?? error)) };
  }

  componentDidCatch(error) {
    console.error(`[ChunkErrorBoundary] ${this.props.name} could not open:`, error);
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
        description={this.state.loadFailure ? t('chunkError.loadFailed') : t('chunkError.threw')}
        footer={
          <>
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => this.setState({ failed: false })}>
              {t('chunkError.dismiss')}
            </Button>
            <Button variant="primary" size="lg" className="flex-1" data-autofocus onClick={() => window.location.reload()}>
              {t('chunkError.reload')}
            </Button>
          </>
        }
      />
    );
  }
}
