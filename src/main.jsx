import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';

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
          background: '#0a0a0f',
          color: '#e4e4e7',
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
      <SplashDismisser>
        <App />
      </SplashDismisser>
    </ErrorBoundary>
  </React.StrictMode>
);
