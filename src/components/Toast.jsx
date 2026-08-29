import React, { useEffect } from 'react';
import { ToastShell } from './ui/ToastShell';
import { Button } from './ui/Button';
import { AlertCircle, X, CheckCircle, Info, AlertTriangle } from 'lucide-react';
import { useT } from '../i18n/index.js';

export function Toast({ message, type = 'error', duration = 5000, onClose }) {
  const t = useT();
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(onClose, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onClose]);

  const icons = {
    error: AlertCircle,
    success: CheckCircle,
    info: Info,
    warning: AlertTriangle
  };

  const colors = {
    error: 'bg-mail-danger/10 border-mail-danger/20 text-mail-danger',
    success: 'bg-mail-success/10 border-mail-success/20 text-mail-success',
    info: 'bg-mail-accent/10 border-mail-accent/20 text-mail-accent-text',
    warning: 'bg-mail-warning-tint border-mail-warning/20 text-mail-warning'
  };
  
  const Icon = icons[type] || AlertCircle;
  const colorClass = colors[type] || colors.error;
  
  return (
    <ToastShell
      position="bottom-center"
      role={type === 'error' ? 'alert' : 'status'}
      bare
      className={`flex items-center gap-3 px-4 py-3 border rounded-xl ${colorClass}`}
    >
      <Icon size={18} />
      <span className="text-sm font-medium max-w-md">{message}</span>
      <Button
        variant="ghost"
        icon
        size="xs"
        onClick={onClose}
        aria-label={t('toast.dismiss')}
        className="hover:bg-white/10 ml-2"
      >
        <X size={14} />
      </Button>
    </ToastShell>
  );
}
