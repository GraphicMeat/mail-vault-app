import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../../stores/settingsStore';
import { isDaemonAvailable, getDaemonStatus } from '../../services/daemonClient';
import {
  Server, CheckCircle2, XCircle, Loader, Clock, Zap,
} from 'lucide-react';

export function DaemonSettings() {
  const daemonMode = useSettingsStore(s => s.daemonMode);
  const setDaemonMode = useSettingsStore(s => s.setDaemonMode);
  const [status, setStatus] = useState(null); // { version, uptime_secs, data_dir }
  const [checking, setChecking] = useState(false);
  const [connected, setConnected] = useState(null); // null = unknown, true/false
  const [serviceInstalled, setServiceInstalled] = useState(null);
  const [installing, setInstalling] = useState(false);

  const checkConnection = async () => {
    setChecking(true);
    try {
      const ok = await isDaemonAvailable();
      setConnected(ok);
      if (ok) {
        const s = await getDaemonStatus();
        setStatus(s);
      }
    } catch {
      setConnected(false);
    }
    try {
      const installed = await invoke('is_daemon_service_installed');
      setServiceInstalled(installed);
    } catch { /* ignore */ }
    setChecking(false);
  };

  const handleModeChange = async (mode) => {
    setInstalling(true);
    try {
      if (mode === 'always-on') {
        await invoke('install_daemon_service');
        setServiceInstalled(true);
      } else {
        await invoke('uninstall_daemon_service');
        setServiceInstalled(false);
      }
      setDaemonMode(mode);
      // Re-check connection after a moment (service needs time to start)
      setTimeout(() => checkConnection(), 2000);
    } catch (e) {
      console.error('Failed to toggle daemon service:', e);
    }
    setInstalling(false);
  };

  useEffect(() => { checkConnection(); }, []);

  return (
    <div className="p-6 space-y-6">
      {/* Connection Status */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${connected ? 'bg-emerald-500/10' : connected === false ? 'bg-red-500/10' : 'bg-mail-accent/10'}`}>
            {checking ? (
              <Loader size={20} className="text-mail-accent animate-spin" />
            ) : connected ? (
              <CheckCircle2 size={20} className="text-emerald-500" />
            ) : connected === false ? (
              <XCircle size={20} className="text-red-500" />
            ) : (
              <Server size={20} className="text-mail-accent" />
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-mail-text">
              {checking ? 'Checking...' : connected ? 'Daemon Connected' : connected === false ? 'Daemon Not Running' : 'Background Daemon'}
            </h3>
            {status && (
              <p className="text-xs text-mail-text-muted">
                v{status.version} &middot; {status.data_dir}
              </p>
            )}
          </div>
        </div>

        {connected === false && (
          <p className="text-xs text-mail-text-muted mb-3">
            The daemon is not currently reachable. In on-demand mode it starts when the app opens. In always-on mode, check that the system service is installed.
          </p>
        )}

        <button
          onClick={checkConnection}
          disabled={checking}
          className="text-xs font-medium text-mail-accent hover:text-mail-accent/80 disabled:opacity-50 transition-colors"
        >
          {checking ? 'Checking...' : 'Test Connection'}
        </button>
      </div>

      {/* Daemon Mode */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h3 className="text-sm font-semibold text-mail-text mb-1">Daemon Mode</h3>
        <p className="text-xs text-mail-text-muted mb-4">
          Controls when the background daemon runs. The daemon handles email sync, backups, and AI classification.
        </p>

        <div className="space-y-3">
          <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
            daemonMode === 'on-demand' ? 'border-mail-accent bg-mail-accent/5' : 'border-mail-border hover:bg-mail-surface-hover'
          }`}>
            <input
              type="radio"
              name="daemonMode"
              checked={daemonMode === 'on-demand'}
              onChange={() => handleModeChange('on-demand')}
              disabled={installing}
              className="mt-0.5 accent-mail-accent"
            />
            <div>
              <div className="flex items-center gap-2">
                <Clock size={14} className="text-mail-text-muted" />
                <span className="text-sm font-medium text-mail-text">On demand</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-mail-surface-hover text-mail-text-muted">Default</span>
              </div>
              <p className="text-xs text-mail-text-muted mt-1">
                Starts when you open MailVault, stops when you quit. No background activity between sessions. Lower resource usage.
              </p>
            </div>
          </label>

          <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
            daemonMode === 'always-on' ? 'border-mail-accent bg-mail-accent/5' : 'border-mail-border hover:bg-mail-surface-hover'
          }`}>
            <input
              type="radio"
              name="daemonMode"
              checked={daemonMode === 'always-on'}
              onChange={() => handleModeChange('always-on')}
              disabled={installing}
              className="mt-0.5 accent-mail-accent"
            />
            <div>
              <div className="flex items-center gap-2">
                <Zap size={14} className="text-emerald-500" />
                <span className="text-sm font-medium text-mail-text">Always on</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">Recommended</span>
              </div>
              <p className="text-xs text-mail-text-muted mt-1">
                Runs as a system service even when the app is closed. Emails sync in the background, backups run on schedule, and AI classification happens automatically. Uses minimal resources when idle.
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Service Status */}
      {daemonMode === 'always-on' && (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-mail-text mb-2">System Service</h3>
          <div className="flex items-center gap-2 text-xs">
            {serviceInstalled ? (
              <>
                <CheckCircle2 size={14} className="text-emerald-500" />
                <span className="text-mail-text-muted">Service installed — daemon starts at login and survives app exit</span>
              </>
            ) : (
              <>
                <XCircle size={14} className="text-amber-500" />
                <span className="text-mail-text-muted">Service not installed</span>
                <button
                  onClick={() => handleModeChange('always-on')}
                  disabled={installing}
                  className="ml-2 text-mail-accent hover:text-mail-accent/80 font-medium"
                >
                  {installing ? 'Installing...' : 'Install Now'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* About */}
      <div className="text-xs text-mail-text-muted space-y-1">
        <p>The daemon is a lightweight background process that handles all server communication, local storage, and AI processing.</p>
        <p>In always-on mode, it's installed as a system service (launchd on macOS, systemd on Linux) and starts automatically at login.</p>
      </div>
    </div>
  );
}
