import './e2eMotion';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import App from './App';
import { setLocale } from './i18n/index.js';
import { useSettingsStore } from './stores/settingsStore';
import { wireConnectivityEvents, installNetMock } from './stores/connectivityStore';
import './styles/index.css';

// Listen to the webview's path-monitor events. Cheap, and the only signal that
// arrives the instant the Wi-Fi drops rather than on the next 30s heartbeat.
wireConnectivityEvents();

// Apply the persisted language once the store has hydrated — and NOT before.
//
// Settings persist through Tauri (`src/stores/safeStorage.js`), so `getItem`
// returns a Promise and hydration finishes after this module runs. Reading the
// language here would see the default `en`; worse, *publishing* it would call
// `setState`, and persist writes that through to `safeStorage` immediately.
// `ensureLoaded` then finds the key already cached and skips the disk copy
// entirely — dropping not just the language but every setting the user saved.
// An eager call here cost the seeded `listPaneSize` in a screenshot run before
// anyone noticed it was costing real users their whole settings file.
useSettingsStore.persist?.onFinishHydration?.(() => {
  setLocale(useSettingsStore.getState().language || 'en').catch(() => {});
});
import { MAIL_DARK_BG, MAIL_DARK_TEXT } from './utils/mailChrome';

// A row can vanish at four layers — the sidecar cache, `emails`, the filters
// that produce `sortedEmails`, and the virtualizer's render window — and from
// the DOM all four look the same. Without a store handle an E2E failure can
// only report "the row isn't there", which is how a cross-account cache bug
// stayed open through several passes. Same compile-time gate as e2eMotion:
// `VITE_E2E` is a constant, so a normal build drops this entirely.
if (import.meta.env.VITE_E2E === '1') {
  // Mock connectivity object. Real network state cannot be driven from a test,
  // and pulling the runner's Wi-Fi would take the mock IMAP server with it, so
  // the suite pins the verdict here instead.
  installNetMock(window);
  import('./stores/mailStore').then(({ useMailStore }) => {
    window.__MAIL_STORE__ = useMailStore;
  });
  // Same reason, one layer over: a link alert is persisted per message, and
  // "the icon is gone" cannot tell a correctly-scoped map from an empty one.
  // The key shape is the assertion.
  import('./stores/settingsStore').then(({ useSettingsStore }) => {
    window.__SETTINGS_STORE__ = useSettingsStore;
  });
  // And one layer over again: a search result is the only row guaranteed not
  // to belong to the folder on screen, and the DOM cannot say which mailbox a
  // row claims. `_mailbox` on the result IS the assertion.
  // Accounts live in mailStore (useAccountStore is a thin wrapper over it), so
  // __MAIL_STORE__ already seeds the welcome-screen gate. What was missing is a
  // way to drive the language: switching it must load a catalog, which a plain
  // store write cannot do. A screenshot run needs exactly this handle.
  import('./i18n/index.js').then(({ setLocale, getLocale, t }) => {
    window.__I18N__ = { setLocale, getLocale, t };
  });
  // The language is a *persisted* setting read through async storage, so a run
  // that wants to know why the UI is English needs to see hydration itself —
  // not just the locale it ended up with.
  window.__SETTINGS_STORE__ = useSettingsStore;
  import('./stores/searchStore').then(({ useSearchStore }) => {
    window.__SEARCH_STORE__ = useSearchStore;
  });
  // The scheduler itself, because "automatic backups are premium" is invisible
  // from the DOM: a stored schedule looks identical whether or not the checker
  // will ever act on it. The queue after a checkAndQueueDue() IS the assertion.
  import('./services/backupScheduler').then(({ backupScheduler }) => {
    window.__BACKUP_SCHEDULER__ = backupScheduler;
  });
  // Below the stores: the two-process seam. `maildir_exists` and
  // `maildir_storage_stats` used to be answered by the daemon in a shape the
  // app read as a bare bool / camelCase struct, and a wrong shape looks exactly
  // like a wrong answer from the DOM. A spec that cannot see whether the daemon
  // was even routed in this run passes vacuously, so expose the routing state
  // together with the two reads that depend on it.
  Promise.all([import('./services/transport.js'), import('./services/db')])
    .then(([transport, db]) => {
      window.__DB_PROBE__ = {
        daemonHealth: () => transport.getDaemonHealth(),
        isEmailSaved: (accountId, mailbox, uid) => db.isEmailSaved(accountId, mailbox, uid),
        storageUsage: () => db.getStorageUsage(),
      };
    });
}

if (navigator.platform?.startsWith('Mac') || navigator.userAgent?.includes('Mac')) {
  document.documentElement.classList.add('platform-mac');
}

// tauri.conf.json sets dragDropEnabled:false so Finder drops reach the page as HTML5
// drag events — Tauri's native handler otherwise swallows them (tauri-runtime-wry
// returns true from its drag-drop handler, and wry then never lets WebKit see the drop).
// The cost: WebKit's default for a file dropped where no handler claimed it is to
// NAVIGATE the webview to that file. Refuse anything no drop zone accepted.
document.addEventListener('dragover', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
});
document.addEventListener('drop', (e) => { if (!e.defaultPrevented) e.preventDefault(); });

// Debug: Log Tauri API availability at startup
console.log('=== MailVault Frontend Initializing ===');
console.log('[main.jsx] window.__TAURI__:', window.__TAURI__);
console.log('[main.jsx] window.__TAURI__.invoke:', window.__TAURI__?.invoke);
console.log('[main.jsx] All __TAURI__ keys:', window.__TAURI__ ? Object.keys(window.__TAURI__) : 'N/A');

// Dismiss splash screen — called from within React tree once something renders
function dismissSplash() {
  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), 300);
  }
}

// Error boundary to catch React rendering failures
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] React rendering failed:', error, errorInfo);
    this.setState({ stack: error?.stack || errorInfo?.componentStack || '' });
    dismissSplash();
  }

  render() {
    if (this.state.hasError) {
      return React.createElement('div', {
        style: {
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: MAIL_DARK_BG,
          color: MAIL_DARK_TEXT,
          fontFamily: "'Instrument Sans', system-ui, sans-serif",
          padding: '2rem',
          textAlign: 'center'
        }
      },
        React.createElement('div', null,
          React.createElement('h1', {
            style: { fontSize: '1.5rem', fontWeight: 700, marginBottom: '1rem' }
          },
            React.createElement('span', { style: { color: '#6366f1' } }, 'Mail'),
            'Vault'
          ),
          React.createElement('p', {
            style: { color: '#71717a', marginBottom: '1rem' }
          }, 'Something went wrong. Please restart the app.'),
          React.createElement('p', {
            style: { color: '#71717a', fontSize: '0.75rem', fontFamily: 'monospace', maxWidth: '500px', wordBreak: 'break-word' }
          }, String(this.state.error)),
          this.state.stack && React.createElement('pre', {
            style: { color: '#52525b', fontSize: '0.65rem', fontFamily: 'monospace', maxWidth: '500px', wordBreak: 'break-word', whiteSpace: 'pre-wrap', textAlign: 'left', marginTop: '0.75rem', maxHeight: '200px', overflow: 'auto', background: '#18181b', padding: '0.75rem', borderRadius: '0.5rem' }
          }, this.state.stack),
          React.createElement('button', {
            onClick: () => window.location.reload(),
            style: {
              marginTop: '1rem',
              padding: '0.5rem 1.5rem',
              background: '#6366f1',
              color: 'white',
              border: 'none',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontSize: '0.875rem'
            }
          }, 'Reload')
        )
      );
    }
    return this.props.children;
  }
}

// Component that dismisses splash once mounted (proves React rendered)
function SplashDismisser({ children }) {
  React.useEffect(() => {
    dismissSplash();
  }, []);
  return children;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/* reducedMotion="user" makes every framer-motion animation in the app
          honour the OS "Reduce motion" setting — transforms and scales are
          dropped, opacity still crossfades. CSS-driven motion is handled by the
          matching @media block in styles/index.css. */}
      <MotionConfig reducedMotion="user">
        <SplashDismisser>
          <App />
        </SplashDismisser>
      </MotionConfig>
    </ErrorBoundary>
  </React.StrictMode>
);
